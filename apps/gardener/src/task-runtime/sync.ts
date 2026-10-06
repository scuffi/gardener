import { pinnedWorkflowRefPattern, syncRequestV1Schema, syncWorkflowRefFor, taskBundleV1Schema, taskWorkflowRefFor } from "@gardener/contracts";
import { canonicalJson, canonicalSha256 } from "@gardener/core";
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../env";
import { releaseMismatchAdvice } from "./workflow-refs";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class SyncRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Enrollment {
  repository_id: string;
  owner_id: string;
  owner_login: string;
  repository_name: string;
  visibility: string;
  plan_job_workflow_ref: string;
  oidc_audience: string;
  enabled: number;
}

export interface SyncOptions {
  /** The task workflow of the release this Worker was deployed from. */
  releaseWorkflowRef?: string | undefined;
  key?: JWTVerifyGetKey;
  now?: Date;
}

export async function handleSyncRequest(request: Request, env: Env, options: SyncOptions = {}): Promise<Response> {
  try {
    if (request.method !== "POST") throw new SyncRefused(405, "Use POST");
    const result = await syncRepository(env.DB, request, {
      releaseWorkflowRef: env.GARDENER_RELEASE_WORKFLOW_REF,
      ...options,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SyncRefused) return Response.json({ ok: false, error: error.message }, { status: error.status });
    console.error("gardener sync failed", error);
    return Response.json({ ok: false, error: "Gardener sync failed" }, { status: 500 });
  }
}

/**
 * Makes an enrolled repository's live tasks exactly the ones compiled from a
 * push to its default branch. The request is authenticated by a GitHub OIDC
 * token from the pinned sync workflow, so the bundles come from Gardener's own
 * compiler run on a default-branch commit, never from a pull request.
 */
export async function syncRepository(
  db: D1Database,
  request: Request,
  options: SyncOptions,
): Promise<{ repositoryId: string; commitSha: string; tasks: Array<{ taskId: string; bundleHash: string }> }> {
  const token = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) throw new SyncRefused(401, "A GitHub OIDC bearer token is required");
  let unverified: Record<string, unknown>;
  try {
    unverified = decodeJwt(token);
  } catch {
    throw new SyncRefused(401, "The OIDC token is malformed");
  }
  // One answer for an unknown repository and a bad token, so the endpoint
  // doesn't reveal which repositories are connected.
  const unauthenticated = new SyncRefused(
    401,
    "The OIDC token is not valid for this Gardener runtime, or the repository is not connected (run gardener connect once)",
  );
  const repositoryId = typeof unverified.repository_id === "string" ? unverified.repository_id : "";
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw unauthenticated;
  const enrollment = await db.prepare(
    "SELECT repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,oidc_audience,enabled " +
      "FROM actions_repository_enrollments WHERE repository_id=?",
  ).bind(repositoryId).first<Enrollment>();
  if (!enrollment) throw unauthenticated;

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, options.key ?? GITHUB_OIDC_JWKS, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: enrollment.oidc_audience,
      algorithms: ["RS256"],
      ...(options.now === undefined ? {} : { currentDate: options.now }),
    }));
  } catch {
    throw unauthenticated;
  }
  const body = await boundedJson(request);
  const parsed = syncRequestV1Schema.safeParse(body);
  if (!parsed.success) {
    throw new SyncRefused(400, `Invalid sync request: ${parsed.error.issues[0]?.message ?? "bad shape"}. ${releaseMismatchAdvice(options.releaseWorkflowRef)}`);
  }
  const input = parsed.data;

  const expected: Record<string, string> = {
    repository_id: enrollment.repository_id,
    repository_owner_id: enrollment.owner_id,
    repository: `${enrollment.owner_login}/${enrollment.repository_name}`,
    runner_environment: "github-hosted",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (claims[name] !== value) throw new SyncRefused(403, `OIDC claim ${name} does not match the connected repository`);
  }
  if (claims.environment !== undefined) throw new SyncRefused(403, "The sync token must not be bound to an environment");
  if (claims.event_name !== "push" && claims.event_name !== "workflow_dispatch") {
    throw new SyncRefused(403, "Only a push or a manual run can sync tasks");
  }
  if (claims.ref !== `refs/heads/${input.defaultBranch}`) {
    throw new SyncRefused(403, `Only the default branch (${input.defaultBranch}) can sync tasks, not ${String(claims.ref)}`);
  }

  // The sync must run Gardener's own workflow, at the pin the repository is
  // enrolled on or at the release this Worker was deployed from.
  // Both must be Gardener's own workflows: the repository that ships the
  // release this Worker runs. An enrollment pinned elsewhere (a copied
  // gardener.json naming another owner) can't make that owner's workflow a
  // standing way to rewrite tasks.
  const release = options.releaseWorkflowRef ? pinnedWorkflowRefPattern.exec(options.releaseWorkflowRef) : null;
  if (!release) throw new SyncRefused(503, "This Gardener runtime has no release pin; redeploy it with gardener deploy");
  const accepted = [enrollment.plan_job_workflow_ref, options.releaseWorkflowRef!]
    .filter((ref) => pinnedWorkflowRefPattern.exec(ref)?.[1] === release[1])
    .map(syncWorkflowRefFor)
    .filter((ref): ref is string => ref !== null);
  const jobWorkflowRef = String(claims.job_workflow_ref ?? "");
  if (!accepted.includes(jobWorkflowRef)) {
    throw new SyncRefused(403, `Sync workflow ${jobWorkflowRef} is not the repository's pinned Gardener release or this runtime's. ${releaseMismatchAdvice(options.releaseWorkflowRef, jobWorkflowRef)}`);
  }
  const taskWorkflowRef = taskWorkflowRefFor(jobWorkflowRef)!;
  if (input.workflowRef !== taskWorkflowRef) {
    throw new SyncRefused(409, `The lock pins ${input.workflowRef}, not ${taskWorkflowRef}; run gardener generate with the matching release`);
  }
  if (enrollment.enabled !== 1) throw new SyncRefused(403, "This repository is disabled in Gardener");

  const runId = String(claims.run_id ?? "");
  const runAttempt = Number(claims.run_attempt ?? Number.NaN);
  const commitSha = String(claims.sha ?? "");
  const actor = String(claims.actor ?? "");
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1
    || !/^[0-9a-f]{40}$/.test(commitSha) || actor.length < 1 || actor.length > 100) {
    throw new SyncRefused(401, "The OIDC token has invalid run claims");
  }

  const tasks: Array<{ taskId: string; source: string; bundleHash: string; bundleJson: string }> = [];
  const seen = new Set<string>();
  for (const task of input.tasks) {
    const bundle = taskBundleV1Schema.safeParse(task.bundle);
    if (!bundle.success) {
      const issue = bundle.error.issues[0];
      const where = issue ? ` (${issue.path.join(".") || "bundle"}: ${issue.message})` : "";
      throw new SyncRefused(400, `Task ${task.taskId} is not a task bundle this runtime accepts${where}. ${releaseMismatchAdvice(options.releaseWorkflowRef, jobWorkflowRef)}`);
    }
    if (bundle.data.taskId !== task.taskId) throw new SyncRefused(400, `Task ${task.taskId} does not match its bundle`);
    if (seen.has(task.taskId)) throw new SyncRefused(400, `Task ${task.taskId} appears twice`);
    seen.add(task.taskId);
    tasks.push({
      taskId: task.taskId,
      source: `.gardener/${task.source}`,
      bundleHash: await canonicalSha256(bundle.data),
      bundleJson: canonicalJson(bundle.data),
    });
  }

  const summary = tasks.map(({ taskId, bundleHash }) => ({ taskId, bundleHash }));
  const statements = [
    // First, so a stale run aborts the batch before anything changes.
    db.prepare(
      "INSERT INTO actions_repository_syncs(repository_id,github_run_id,github_run_attempt,commit_sha,actor_login,workflow_ref,tasks_json) VALUES (?,?,?,?,?,?,?)",
    ).bind(repositoryId, runId, runAttempt, commitSha, actor, jobWorkflowRef, JSON.stringify(summary)),
    db.prepare(
      "UPDATE actions_repository_enrollments SET plan_job_workflow_ref=?,effects_job_workflow_ref=?,updated_at=CURRENT_TIMESTAMP " +
        "WHERE repository_id=? AND (plan_job_workflow_ref<>? OR effects_job_workflow_ref IS NOT ?)",
    ).bind(taskWorkflowRef, taskWorkflowRef, repositoryId, taskWorkflowRef, taskWorkflowRef),
    ...tasks.flatMap((task) => [
      db.prepare("INSERT INTO actions_task_bundles(bundle_hash,task_id,bundle_json) VALUES (?,?,?) ON CONFLICT(bundle_hash) DO NOTHING")
        .bind(task.bundleHash, task.taskId, task.bundleJson),
      db.prepare(
        "INSERT INTO actions_repository_tasks(repository_id,bundle_hash,task_id,source_path,enabled) VALUES (?,?,?,?,1) " +
          "ON CONFLICT(repository_id,bundle_hash) DO UPDATE SET task_id=excluded.task_id,source_path=excluded.source_path,enabled=1,updated_at=CURRENT_TIMESTAMP",
      ).bind(repositoryId, task.bundleHash, task.taskId, task.source),
    ]),
    // Everything not in this commit stops. json_each keeps it one statement for
    // any number of tasks, including none.
    db.prepare(
      "UPDATE actions_repository_tasks SET enabled=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND enabled=1 " +
        "AND bundle_hash NOT IN (SELECT value FROM json_each(?))",
    ).bind(repositoryId, JSON.stringify(tasks.map((task) => task.bundleHash))),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (/gardener_sync_stale/.test(String(error))) {
      throw new SyncRefused(409, "A newer sync has already been applied; this older run changes nothing");
    }
    if (/UNIQUE constraint failed: actions_repository_syncs/.test(String(error))) {
      throw new SyncRefused(409, "This run attempt has already synced");
    }
    throw error;
  }
  return { repositoryId, commitSha, tasks: summary };
}

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyncRefused(400, "The sync request has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new SyncRefused(413, "The sync request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new SyncRefused(400, "The sync request is not JSON");
  }
}
