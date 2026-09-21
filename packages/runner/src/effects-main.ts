import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { taskEffectPlanV1Schema } from "@gardener/contracts";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import type { PublicSessionCapability, RunnerActionResultV1, RunnerActionV1, RunnerCapability, RunnerEffectReceiptV1 } from "@gardener/protocol";
import { helloFromOidcToken, sessionSocketUrl } from "./context";

async function main(): Promise<void> {
  try {
    const artifactPath = core.getInput("artifact-path", { required: true });
    const expectedSha256 = core.getInput("expected-sha256", { required: true });
    const token = core.getInput("github-token", { required: true });
    const harnessUrl = core.getInput("harness-url", { required: true });
    core.setSecret(token);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected-sha256 must be a SHA-256 digest");
    const bytes = await readFile(artifactPath);
    if (bytes.byteLength > 128 * 1024) throw new Error("Effect artifact is too large");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error("Effect artifact digest mismatch");
    const plan = taskEffectPlanV1Schema.parse(JSON.parse(bytes.toString("utf8")));
    const event = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8")) as Record<string, any>;
    if (requiredEnvironment("GITHUB_REPOSITORY") !== plan.repository.fullName) throw new Error("Effect repository binding mismatch");
    if (String(event.repository?.id ?? "") !== plan.repository.id) throw new Error("Effect repository identity mismatch");
    if (requiredEnvironment("GITHUB_SHA") !== plan.provenance.commitSha) throw new Error("Effect commit binding mismatch");
    if (requiredEnvironment("GITHUB_RUN_ID") !== plan.provenance.workflowRunId
      || Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")) !== plan.provenance.workflowRunAttempt) {
      throw new Error("Effect workflow run binding mismatch");
    }
    if (event.action !== "opened" || Number(event.issue?.number) !== plan.issueNumber) throw new Error("Effect issue binding mismatch");

    const marker = `<!-- gardener-operation:${plan.operationId} -->`;
    const body = renderGardenerComment(plan, marker);
    const existing = await findExistingComment(plan.repository.fullName, plan.issueNumber, marker, token);
    const receipt = existing ?? await createComment(plan.repository.fullName, plan.issueNumber, body, token);
    await recordReceipt(harnessUrl, plan.bundleHash, {
      schemaVersion: "gardener.runner.effect-receipt/v1",
      planRunId: plan.runId,
      bundleHash: plan.bundleHash,
      artifactSha256: actualSha256,
      operationId: plan.operationId,
      kind: plan.kind,
      commentId: String(receipt.id),
      commentUrl: receipt.html_url,
    });
    core.setOutput("comment-id", String(receipt.id));
    core.setOutput("comment-url", receipt.html_url);
    core.setOutput("operation-id", plan.operationId);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Gardener effect failed");
  }
}

class EffectsRunnerApi extends RpcTarget implements RunnerCapability {
  execute(_action: RunnerActionV1): Promise<RunnerActionResultV1> { return Promise.reject(new Error("Effects job cannot execute planning actions")); }
  result(_operationId: string): Promise<RunnerActionResultV1 | null> { return Promise.resolve(null); }
  cancel(_operationId: string): Promise<void> { return Promise.resolve(); }
}

async function recordReceipt(harnessUrl: string, bundleHash: string, receipt: RunnerEffectReceiptV1): Promise<void> {
  const audience = new URL(harnessUrl).origin;
  const oidcToken = await core.getIDToken(audience);
  core.setSecret(oidcToken);
  const hello = helloFromOidcToken(oidcToken, bundleHash, "effects");
  const root = newWebSocketRpcSession<PublicSessionCapability>(sessionSocketUrl(harnessUrl, hello, "effects"));
  try {
    const session = root.authenticate(hello, oidcToken, new EffectsRunnerApi());
    await session.recordEffect(receipt);
  } finally {
    root[Symbol.dispose]();
  }
}

function renderGardenerComment(
  plan: ReturnType<typeof taskEffectPlanV1Schema.parse>,
  marker: string,
): string {
  const repositoryUrl = `https://github.com/${plan.repository.fullName}`;
  const sourcePath = plan.provenance.sourcePath.split("/").map(encodeURIComponent).join("/");
  const sourceUrl = `${repositoryUrl}/blob/${plan.provenance.commitSha}/${sourcePath}`;
  const runUrl = `${repositoryUrl}/actions/runs/${plan.provenance.workflowRunId}/attempts/${plan.provenance.workflowRunAttempt}`;
  const commitUrl = `${repositoryUrl}/commit/${plan.provenance.commitSha}`;
  return [
    `## 🌱 Gardener · ${escapeMarkdownInline(plan.taskName)}`,
    "",
    plan.body,
    "",
    "<details>",
    "<summary>Gardener provenance</summary>",
    "",
    `[Task source](${sourceUrl}) · [Workflow run](${runUrl}) · [Commit](${commitUrl})`,
    "",
    `Bundle \`${plan.bundleHash}\`  `,
    `Operation \`${plan.operationId}\``,
    "",
    "</details>",
    "",
    marker,
  ].join("\n");
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, "\\$&");
}

interface CommentReceipt { id: number; html_url: string; body?: string }

async function findExistingComment(repository: string, issue: number, marker: string, token: string): Promise<CommentReceipt | undefined> {
  const response = await githubFetch(`https://api.github.com/repos/${repository}/issues/${issue}/comments?per_page=100`, token);
  const comments = await response.json() as CommentReceipt[];
  return comments.find((comment) => comment.body?.includes(marker));
}

async function createComment(repository: string, issue: number, body: string, token: string): Promise<CommentReceipt> {
  const response = await githubFetch(`https://api.github.com/repos/${repository}/issues/${issue}/comments`, token, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return await response.json() as CommentReceipt;
}

async function githubFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "gardener-effects-v1",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub comment effect failed with HTTP ${response.status}`);
  return response;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main();
