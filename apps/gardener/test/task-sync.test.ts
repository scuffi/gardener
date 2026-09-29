/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonicalSha256 } from "@gardener/core";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";
import { syncRepository, SyncRefused } from "../src/task-runtime/sync";
import { d1Database } from "./sqlite";

const audience = "https://gardener.example.workers.dev";
const now = new Date("2026-09-29T12:00:00.000Z");
const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);
const taskRef = (sha: string) => `scuffi/gardener/.github/workflows/gardener-task.yml@${sha}`;
const syncRef = (sha: string) => `scuffi/gardener/.github/workflows/gardener-sync.yml@${sha}`;

let privateKey: CryptoKey;
let key: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256", use: "sig" }] });
});

function database() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  }
  sqlite.prepare(
    "INSERT INTO actions_repository_enrollments(repository_id,owner_id,owner_login,repository_name,visibility,plan_job_workflow_ref,effects_job_workflow_ref,oidc_audience) VALUES (?,?,?,?,?,?,?,?)",
  ).run("100", "200", "scuffi", "demo", "public", taskRef(oldSha), taskRef(oldSha), audience);
  return { sqlite, db: d1Database(sqlite) };
}

async function token(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    repository_id: "100",
    repository_owner_id: "200",
    repository: "scuffi/demo",
    runner_environment: "github-hosted",
    event_name: "push",
    ref: "refs/heads/main",
    job_workflow_ref: syncRef(oldSha),
    run_id: "5000",
    run_attempt: "1",
    sha: "c".repeat(40),
    actor: "scuffi",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience(audience)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(privateKey);
}

const bundle = () => structuredClone(inspectRepositoryFixtureBundle()) as Record<string, unknown>;
const task = (overrides: Record<string, unknown> = {}) => {
  const value = { ...bundle(), ...overrides };
  return { taskId: String(value.taskId), source: `tasks/${String(value.taskId)}/TASK.md`, bundle: value };
};

async function sync(
  db: D1Database,
  input: { claims?: Record<string, unknown>; tasks?: unknown[]; workflowRef?: string; defaultBranch?: string; release?: string } = {},
) {
  const request = new Request(`${audience}/v1/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token(input.claims)}` },
    body: JSON.stringify({
      schemaVersion: "gardener.sync-request/v1",
      defaultBranch: input.defaultBranch ?? "main",
      workflowRef: input.workflowRef ?? taskRef(oldSha),
      tasks: input.tasks ?? [task()],
    }),
  });
  return syncRepository(db, request, { key, now, releaseWorkflowRef: input.release ?? taskRef(newSha) });
}

function rows(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT task_id,bundle_hash,enabled FROM actions_repository_tasks ORDER BY task_id,enabled").all();
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SyncRefused) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("expected the sync to be refused");
}

describe("repository sync", () => {
  it("makes the live tasks exactly the committed ones and records the sync", async () => {
    const { sqlite, db } = database();
    const first = task();
    const firstHash = await canonicalSha256(first.bundle);
    await expect(sync(db, { tasks: [first] })).resolves.toMatchObject({ tasks: [{ taskId: first.taskId, bundleHash: firstHash }] });
    expect(rows(sqlite)).toEqual([{ task_id: first.taskId, bundle_hash: firstHash, enabled: 1 }]);

    // An edit replaces the bundle; the old one stops.
    const edited = task({ instructions: "Edited instructions." });
    const editedHash = await canonicalSha256(edited.bundle);
    await sync(db, { tasks: [edited], claims: { run_id: "5001" } });
    expect(rows(sqlite)).toEqual([
      { task_id: first.taskId, bundle_hash: firstHash, enabled: 0 },
      { task_id: first.taskId, bundle_hash: editedHash, enabled: 1 },
    ]);

    // A revert brings the first bundle back; deleting every task stops all.
    await sync(db, { tasks: [first], claims: { run_id: "5002" } });
    expect(rows(sqlite)).toContainEqual({ task_id: first.taskId, bundle_hash: firstHash, enabled: 1 });
    await sync(db, { tasks: [], claims: { run_id: "5003" } });
    expect((rows(sqlite) as Array<{ enabled: number }>).every((row) => row.enabled === 0)).toBe(true);

    expect(sqlite.prepare("SELECT github_run_id,commit_sha,actor_login,workflow_ref FROM actions_repository_syncs ORDER BY github_run_id").all())
      .toHaveLength(4);
    // Each enabled change is audited by the existing control-audit trigger.
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM actions_control_audit WHERE scope='task'").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it("refuses an older run once a newer one has synced, changing nothing", async () => {
    const { sqlite, db } = database();
    await sync(db, { claims: { run_id: "5010" } });
    const before = rows(sqlite);
    await expect(refusal(sync(db, { tasks: [], claims: { run_id: "5009" } }))).resolves.toMatchObject({ status: 409 });
    expect(rows(sqlite)).toEqual(before);
    // A rerun of the same run is fine.
    await expect(sync(db, { claims: { run_id: "5010", run_attempt: "2" } })).resolves.toBeDefined();
  });

  it("accepts the runtime's own release and moves the enrollment to it", async () => {
    const { sqlite, db } = database();
    await sync(db, { claims: { job_workflow_ref: syncRef(newSha) }, workflowRef: taskRef(newSha) });
    expect(sqlite.prepare("SELECT plan_job_workflow_ref,effects_job_workflow_ref FROM actions_repository_enrollments").get())
      .toEqual({ plan_job_workflow_ref: taskRef(newSha), effects_job_workflow_ref: taskRef(newSha) });
  });

  it("refuses every run that is not the pinned sync workflow on the default branch", async () => {
    const { sqlite, db } = database();
    const cases: Array<[Parameters<typeof sync>[1], number, RegExp]> = [
      [{ claims: { job_workflow_ref: syncRef("d".repeat(40)) } }, 403, /not the repository's pinned Gardener release/],
      [{ claims: { job_workflow_ref: taskRef(oldSha) } }, 403, /not the repository's pinned/],
      [{ claims: { job_workflow_ref: `evil/gardener/.github/workflows/gardener-sync.yml@${oldSha}` } }, 403, /not the repository's pinned/],
      [{ claims: { ref: "refs/heads/feature" } }, 403, /Only the default branch/],
      [{ claims: { ref: "refs/pull/7/merge" } }, 403, /Only the default branch/],
      [{ claims: { ref: "refs/heads/feature" }, defaultBranch: "main" }, 403, /Only the default branch/],
      [{ claims: { event_name: "pull_request" } }, 403, /push or a manual run/],
      // pull_request_target runs with the base branch as its ref, so only the
      // event check stops it.
      [{ claims: { event_name: "pull_request_target" } }, 403, /push or a manual run/],
      [{ claims: { event_name: "merge_group", ref: "refs/heads/gh-readonly-queue/main/pr-1" } }, 403, /push or a manual run/],
      [{ claims: { ref: "refs/heads/gh-readonly-queue/main/pr-1" } }, 403, /Only the default branch/],
      [{ claims: { ref: "refs/tags/v1" } }, 403, /Only the default branch/],
      [{ claims: { repository: "scuffi/other" } }, 403, /claim repository/],
      [{ claims: { repository_owner_id: "999" } }, 403, /claim repository_owner_id/],
      [{ claims: { runner_environment: "self-hosted" } }, 403, /runner_environment/],
      [{ claims: { environment: "prod" } }, 403, /environment/],
      // An unknown repository answers exactly like a bad token.
      [{ claims: { repository_id: "101" } }, 401, /not valid for this Gardener runtime, or the repository is not connected/],
      [{ workflowRef: taskRef(newSha) }, 409, /The lock pins/],
      [{ tasks: [{ ...task(), taskId: "other" }] }, 400, /does not match its bundle/],
      [{ tasks: [task(), task()] }, 400, /appears twice/],
      [{ tasks: [{ ...task(), bundle: { nope: true } }] }, 400, /not a valid task bundle/],
      [{ tasks: [{ ...task(), source: "tasks/../TASK.md" }] }, 400, /Invalid sync request/],
    ];
    for (const [input, status, message] of cases) {
      const result = await refusal(sync(db, input));
      expect(result.status, JSON.stringify(input)).toBe(status);
      expect(result.message).toMatch(message);
    }
    expect(rows(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM actions_repository_syncs").get()).toEqual({ n: 0 });
  });

  it("trusts only the runtime's own release repository, even for an enrollment pinned elsewhere", async () => {
    const { sqlite, db } = database();
    const evil = (file: string, sha: string) => `evil/gardener/.github/workflows/${file}@${sha}`;
    sqlite.prepare("UPDATE actions_repository_enrollments SET plan_job_workflow_ref=?").run(evil("gardener-task.yml", oldSha));
    await expect(refusal(sync(db, {
      claims: { job_workflow_ref: evil("gardener-sync.yml", oldSha) },
      workflowRef: evil("gardener-task.yml", oldSha),
    }))).resolves.toMatchObject({ status: 403 });
    // The runtime's own release is still accepted, and repairs the enrollment.
    await sync(db, { claims: { job_workflow_ref: syncRef(newSha) }, workflowRef: taskRef(newSha) });
    expect(sqlite.prepare("SELECT plan_job_workflow_ref FROM actions_repository_enrollments").get())
      .toEqual({ plan_job_workflow_ref: taskRef(newSha) });
  });

  it("refuses without a release pin, and answers a duplicate run attempt with 409", async () => {
    const { db } = database();
    const request = async () => new Request(`${audience}/v1/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ schemaVersion: "gardener.sync-request/v1", defaultBranch: "main", workflowRef: taskRef(oldSha), tasks: [] }),
    });
    await expect(refusal(syncRepository(db, await request(), { key, now }))).resolves.toMatchObject({ status: 503 });
    await sync(db, { claims: { run_id: "6000" } });
    await expect(refusal(sync(db, { claims: { run_id: "6000" } }))).resolves.toMatchObject({ status: 409, message: expect.stringMatching(/already synced/) });
  });

  it("refuses a disabled repository, a wrong audience, and a missing token", async () => {
    const { sqlite, db } = database();
    sqlite.prepare("UPDATE actions_repository_enrollments SET enabled=0").run();
    await expect(refusal(sync(db))).resolves.toMatchObject({ status: 403, message: expect.stringMatching(/disabled/) });

    const other = database();
    other.sqlite.prepare("UPDATE actions_repository_enrollments SET oidc_audience='https://elsewhere.example'").run();
    await expect(refusal(sync(other.db))).resolves.toMatchObject({ status: 401 });

    const bare = new Request(`${audience}/v1/sync`, { method: "POST", body: "{}" });
    await expect(refusal(syncRepository(db, bare, { key, now }))).resolves.toMatchObject({ status: 401 });
  });
});
