import * as core from "@actions/core";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeJsonPointer,
  operationOutputNames,
  operationOutputType,
  operationSchema,
  taskCaptureManifestText,
  taskCaptureRefV1Schema,
  taskEffectPlanV1Schema,
  taskEventBindingFromNormalizedEvent,
  type Operation,
  type OperationKind,
  type TaskEffectPlanV1,
} from "@gardener/contracts";
import {
  EFFECT_TRANSPORT_MAX_BYTES,
  runnerEffectReceiptV1Schema,
  type AuthenticatedSessionCapability,
  type PublicSessionCapability,
  type RunnerActionResultV1,
  type RunnerActionV1,
  type RunnerCapability,
  type RunnerEffectReceiptV1,
  type RunnerPlanStepReceiptV1,
} from "@gardener/protocol";
import { RpcTarget, newWebSocketRpcSession, type RpcStub } from "capnweb";
import { verifyCaptureArtifact } from "./capture";
import { helloFromOidcToken, sessionSocketUrl } from "./context";
import { normalizeGitHubEvent } from "./event";
import {
  canonicalOperationHash,
  executeActionsOperation,
  type GitHubEffectsContext,
  type OperationOutputsV1,
} from "./github-effects";

const inputToken = process.env["INPUT_GITHUB-TOKEN"]?.trim() ?? "";
delete process.env["INPUT_GITHUB-TOKEN"];

interface EffectsSession {
  root: ReturnType<typeof newWebSocketRpcSession<PublicSessionCapability>>;
  session: RpcStub<AuthenticatedSessionCapability>;
}

interface ApplyResult {
  receipt: RunnerEffectReceiptV1;
  outputs: ReadonlyMap<string, Readonly<Record<string, string | number | boolean | null>>>;
}

export async function runEffectsMain(): Promise<void> {
  let connection: EffectsSession | undefined;
  try {
    const artifactPath = core.getInput("artifact-path", { required: true });
    const expectedSha256 = core.getInput("expected-sha256", { required: true });
    const token = inputToken || core.getInput("github-token", { required: true });
    delete process.env["INPUT_GITHUB-TOKEN"];
    const runtimeUrl = core.getInput("runtime-url", { required: true });
    const deadlineAt = Date.parse(core.getInput("deadline-at", { required: true }));
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw new Error("deadline-at must be a future ISO timestamp");
    core.setSecret(token);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected-sha256 must be a SHA-256 digest");

    const bytes = await readFile(artifactPath);
    if (bytes.byteLength > EFFECT_TRANSPORT_MAX_BYTES) throw new Error("Effect artifact is too large");
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (!equalDigest(actualSha256, expectedSha256)) throw new Error("Effect artifact digest mismatch");
    const plan = taskEffectPlanV1Schema.parse(JSON.parse(bytes.toString("utf8")));
    await assertApplyBindings(plan);

    connection = await connectEffectsSession(runtimeUrl, plan.bundleHash);
    const prior = await connection.session.priorEffectReceipt(plan.runId, actualSha256);

    const captureDirectory = core.getInput("capture-artifact-path").trim();
    const capture = await prepareCapture(plan, captureDirectory);
    const result = await applyOrderedPlan({
      plan,
      artifactSha256: actualSha256,
      token,
      deadlineAt,
      prior,
      ...(capture ? { captureDirectory: capture.directory } : {}),
      record: (receipt) => connection!.session.recordEffect(receipt),
    });

    core.setOutput("status", result.receipt.status);
    core.setOutput("completed-operations", String(result.receipt.operations.length));
    const last = result.receipt.operations.at(-1);
    if (last) core.setOutput("operation-id", last.receipt.operationId);
    if (last?.receipt.resourceUrl) core.setOutput("resource-url", last.receipt.resourceUrl);
    for (const outputs of result.outputs.values()) {
      if (typeof outputs.commentId === "string") core.setOutput("comment-id", outputs.commentId);
      if (typeof outputs.commentUrl === "string") core.setOutput("comment-url", outputs.commentUrl);
    }
    if (result.receipt.status === "stopped") {
      const error = last?.receipt.error;
      throw new Error(`Effect plan stopped at ${result.receipt.stoppedAtStep}: ${error?.message ?? "provider operation failed"}`);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Gardener effect failed");
  } finally {
    connection?.root[Symbol.dispose]();
  }
}

export async function applyOrderedPlan(input: {
  plan: TaskEffectPlanV1;
  artifactSha256: string;
  token: string;
  deadlineAt: number;
  prior: RunnerEffectReceiptV1 | null;
  captureDirectory?: string;
  record(receipt: RunnerEffectReceiptV1): Promise<unknown>;
  fetch?: typeof fetch;
  execute?: typeof executeActionsOperation;
}): Promise<ApplyResult> {
  const { plan } = input;
  const ownerAndName = plan.repository.fullName.split("/");
  if (ownerAndName.length !== 2) throw new Error("Plan repository name is invalid");
  const [owner, name] = ownerAndName as [string, string];
  const outputs = new Map<string, Readonly<Record<string, string | number | boolean | null>>>();
  const completed: RunnerPlanStepReceiptV1[] = [];

  let resumeIndex = 0;
  if (input.prior) {
    assertReceiptEnvelope(plan, input.artifactSha256, input.prior);
    for (const [index, entry] of input.prior.operations.entries()) {
      const operation = materializeOperation(plan, index, outputs, owner, name);
      if (entry.stepName !== plan.operations[index]?.stepName
        || entry.receipt.operationId !== operation.id
        || entry.receipt.kind !== operation.kind
        || entry.receipt.operationHash !== canonicalOperationHash(operation)) {
        throw new Error("Prior effect receipt does not match the exact plan prefix");
      }
      if (entry.receipt.status === "conflicted") {
        // Provider conflicts bind immutable state that the exact plan is not
        // allowed to rewrite. Re-running the same bytes cannot resolve one, so
        // preserve the terminal stopped receipt instead of issuing the call
        // again on every rerun-failed-jobs attempt.
        return { receipt: input.prior, outputs };
      }
      if (entry.receipt.status === "failed") break;
      const scalar = validateRecordedOutputs(operation.kind, entry.outputs);
      completed.push(entry);
      outputs.set(entry.stepName, scalar);
      resumeIndex = index + 1;
    }
    if (input.prior.status === "applied") {
      return { receipt: input.prior, outputs };
    }
  }

  for (let index = resumeIndex; index < plan.operations.length; index += 1) {
    const remaining = input.deadlineAt - Date.now();
    const operation = materializeOperation(plan, index, outputs, owner, name);
    if (remaining <= 1_000) {
      const now = new Date().toISOString();
      completed.push(runnerStepReceipt(plan.operations[index]!.stepName, {
        schemaVersion: "v2",
        operationId: operation.id,
        operationHash: canonicalOperationHash(operation),
        kind: operation.kind,
        status: "failed",
        attempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
        attemptedAt: now,
        completedAt: now,
        error: {
          code: "effect_deadline_expired",
          message: "Effect job deadline expired before the operation started",
          retryable: true,
        },
      }, {}));
      const stopped = effectReceipt(plan, input.artifactSha256, completed, "stopped", plan.operations[index]!.stepName);
      await input.record(stopped);
      return { receipt: stopped, outputs };
    }
    const context: GitHubEffectsContext = {
      token: input.token,
      repositoryFullName: plan.repository.fullName,
      attempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
      budgetMs: Math.max(1_000, remaining),
      timeoutMs: Math.min(10_000, Math.max(1_000, remaining)),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.captureDirectory ? { readCapturedFile: captureReader(input.captureDirectory) } : {}),
    };
    const result = await (input.execute ?? executeActionsOperation)(operation, context);
    const scalar = result.outputs === undefined ? {} : scalarOutputs(operation.kind, result.outputs);
    const stepReceipt = runnerStepReceipt(plan.operations[index]!.stepName, result.receipt, scalar);
    completed.push(stepReceipt);

    if (result.receipt.status === "failed" || result.receipt.status === "conflicted") {
      const stopped = effectReceipt(plan, input.artifactSha256, completed, "stopped", plan.operations[index]!.stepName);
      await input.record(stopped);
      return { receipt: stopped, outputs };
    }
    outputs.set(plan.operations[index]!.stepName, scalar);
    const status = completed.length === plan.operations.length ? "applied" : "running";
    const progress = effectReceipt(plan, input.artifactSha256, completed, status, null);
    await input.record(progress);
  }

  const applied = effectReceipt(plan, input.artifactSha256, completed, "applied", null);
  return { receipt: applied, outputs };
}

function materializeOperation(
  plan: TaskEffectPlanV1,
  index: number,
  outputs: ReadonlyMap<string, Readonly<Record<string, string | number | boolean | null>>>,
  owner: string,
  name: string,
): Operation {
  const step = plan.operations[index];
  if (!step) throw new Error(`Plan operation ${index} is missing`);
  const payload = safeClone(step.payload) as Record<string, unknown>;
  for (const [pointer, reference] of Object.entries(step.references)) {
    const source = outputs.get(reference.step);
    if (!source || !Object.hasOwn(source, reference.output)) {
      throw new Error(`Step ${step.stepName} references unavailable output ${reference.step}.${reference.output}`);
    }
    const sourceStep = plan.operations.find((candidate) => candidate.stepName === reference.step);
    if (!sourceStep || operationOutputType(sourceStep.kind, reference.output) === undefined) {
      throw new Error(`Step ${reference.step} does not publish ${reference.output}`);
    }
    setJsonPointer(payload, pointer, source[reference.output]);
  }
  if (step.kind === "commit.create") {
    if (!plan.capture) throw new Error("commit.create has no verified capture manifest");
    if (Object.hasOwn(payload, "files")) throw new Error("commit.create files must come only from capture");
    payload.files = plan.capture.files.map((file) => ({
      path: file.path,
      captured: file.status === "deleted"
        ? { status: "deleted" }
        : { status: file.status, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256 },
    }));
  }
  return operationSchema.parse({
    schemaVersion: "v2",
    id: step.operationId,
    repository: { provider: "github", id: plan.repository.id, owner, name, defaultBranch: plan.repository.defaultBranch },
    kind: step.kind,
    ...payload,
  });
}

function setJsonPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = decodeJsonPointer(pointer);
  if (segments.length === 0) throw new Error("References may not replace the payload root");
  let cursor: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (["__proto__", "constructor", "prototype"].includes(segment)) throw new Error("Unsafe reference pointer");
    const last = index === segments.length - 1;
    if (Array.isArray(cursor)) {
      if (!/^(?:0|[1-9][0-9]?)$/.test(segment)) throw new Error("Reference array index is invalid");
      const position = Number(segment);
      if (last) cursor[position] = value;
      else {
        cursor[position] ??= /^(?:0|[1-9][0-9]?)$/.test(segments[index + 1]!) ? [] : Object.create(null);
        cursor = cursor[position];
      }
    } else if (cursor !== null && typeof cursor === "object") {
      const record = cursor as Record<string, unknown>;
      if (last) Object.defineProperty(record, segment, { value, enumerable: true, writable: true, configurable: true });
      else {
        if (!Object.hasOwn(record, segment)) {
          Object.defineProperty(record, segment, {
            value: /^(?:0|[1-9][0-9]?)$/.test(segments[index + 1]!) ? [] : Object.create(null),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        cursor = record[segment];
      }
    } else throw new Error(`Reference pointer ${pointer} does not address a payload field`);
  }
}

function scalarOutputs(kind: OperationKind, value: OperationOutputsV1): Readonly<Record<string, string | number | boolean | null>> {
  const source = value as unknown as Record<string, unknown>;
  const selected: Record<string, string | number | boolean | null> = {};
  for (const name of operationOutputNames(kind)) {
    const output = source[name];
    if (typeof output !== "string" && typeof output !== "number" && typeof output !== "boolean" && output !== null) {
      throw new Error(`${kind} did not return scalar output ${name}`);
    }
    selected[name] = output;
  }
  return selected;
}

function validateRecordedOutputs(kind: OperationKind, value: Readonly<Record<string, unknown>>): Readonly<Record<string, string | number | boolean | null>> {
  const expected = new Set(operationOutputNames(kind));
  if (Object.keys(value).some((name) => !expected.has(name))) throw new Error(`Receipt carries an output ${kind} does not publish`);
  return scalarOutputs(kind, value as unknown as OperationOutputsV1);
}

function runnerStepReceipt(
  stepName: string,
  receipt: RunnerPlanStepReceiptV1["receipt"],
  outputs: Readonly<Record<string, string | number | boolean | null>>,
): RunnerPlanStepReceiptV1 {
  return { stepName, receipt, outputs };
}

function effectReceipt(
  plan: TaskEffectPlanV1,
  artifactSha256: string,
  operations: RunnerPlanStepReceiptV1[],
  status: "running" | "applied" | "stopped",
  stoppedAtStep: string | null,
): RunnerEffectReceiptV1 {
  return runnerEffectReceiptV1Schema.parse({
    schemaVersion: "gardener.runner.effect-receipt/v1",
    planRunId: plan.runId,
    bundleHash: plan.bundleHash,
    artifactSha256,
    ...(plan.changesSha256 ? { changesSha256: plan.changesSha256 } : {}),
    plannedOperations: plan.operations.length,
    status,
    stoppedAtStep,
    operations,
  });
}

function assertReceiptEnvelope(plan: TaskEffectPlanV1, artifactSha256: string, receipt: RunnerEffectReceiptV1): void {
  if (receipt.planRunId !== plan.runId || receipt.bundleHash !== plan.bundleHash
    || receipt.artifactSha256 !== artifactSha256
    || receipt.plannedOperations !== plan.operations.length || receipt.changesSha256 !== plan.changesSha256) {
    throw new Error("Prior effect receipt is not bound to this exact plan");
  }
}

async function assertApplyBindings(plan: TaskEffectPlanV1): Promise<void> {
  if (requiredEnvironment("GITHUB_REPOSITORY") !== plan.repository.fullName) throw new Error("Effect repository binding mismatch");
  if (requiredEnvironment("GITHUB_REPOSITORY_ID") !== plan.repository.id) throw new Error("Effect repository identity mismatch");
  if (requiredEnvironment("GITHUB_SHA") !== plan.provenance.commitSha) throw new Error("Effect commit binding mismatch");
  if (requiredEnvironment("GITHUB_RUN_ID") !== plan.provenance.workflowRunId) throw new Error("Effect workflow run binding mismatch");
  const currentAttempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT"));
  if (!Number.isSafeInteger(currentAttempt) || currentAttempt < plan.provenance.workflowRunAttempt) {
    throw new Error("Effect workflow attempt predates the plan");
  }
  const raw = JSON.parse(await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8")) as unknown;
  const rawRepository = raw && typeof raw === "object" ? (raw as Record<string, any>).repository : undefined;
  if (String(rawRepository?.id ?? "") !== plan.repository.id) throw new Error("Effect event repository identity mismatch");
  const normalized = normalizeGitHubEvent(requiredEnvironment("GITHUB_EVENT_NAME"), raw);
  if (normalized.repository.defaultBranch !== plan.repository.defaultBranch) throw new Error("Effect default branch binding mismatch");
  const binding = taskEventBindingFromNormalizedEvent(normalized as never);
  if (canonicalJson(binding) !== canonicalJson(plan.event)) throw new Error("Effect event binding mismatch");
}

async function prepareCapture(plan: TaskEffectPlanV1, directory: string): Promise<{ directory: string } | undefined> {
  if (!plan.capture) {
    if (plan.changesSha256 || directory) throw new Error("Effect changes artifact has no capture-bound plan");
    return undefined;
  }
  if (!plan.changesSha256) throw new Error("Capture plan omitted its changes digest");
  if (!directory) throw new Error("capture-artifact-path is required for a capture-bound plan");
  const manifestJson = taskCaptureManifestText(plan.capture);
  const expected = taskCaptureRefV1Schema.parse({
    schemaVersion: "gardener.task-capture-ref/v1",
    captureId: plan.capture.captureId,
    baseSha: plan.capture.baseSha,
    manifestSha256: createHash("sha256").update(manifestJson).digest("hex"),
    changesSha256: plan.changesSha256,
    fileCount: plan.capture.files.length,
    sizeBytes: plan.capture.totalBytes,
  });
  const verified = await verifyCaptureArtifact(directory, expected);
  if (taskCaptureManifestText(verified.manifest) !== manifestJson) throw new Error("Downloaded capture manifest does not match the exact plan");
  return { directory };
}

function captureReader(directory: string): NonNullable<GitHubEffectsContext["readCapturedFile"]> {
  const content = path.join(directory, "content");
  return async ({ sha256, sizeBytes }) => {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Captured content digest is invalid");
    const bytes = await readFile(path.join(content, sha256));
    if (bytes.byteLength !== sizeBytes) throw new Error("Captured content size changed after verification");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!equalDigest(digest, sha256)) throw new Error("Captured content changed after verification");
    return bytes;
  };
}

async function connectEffectsSession(runtimeUrl: string, bundleHash: string): Promise<EffectsSession> {
  const audience = new URL(runtimeUrl).origin;
  const oidcToken = await core.getIDToken(audience);
  core.setSecret(oidcToken);
  const hello = helloFromOidcToken(oidcToken, bundleHash, "effects");
  const root = newWebSocketRpcSession<PublicSessionCapability>(sessionSocketUrl(runtimeUrl, hello, "effects"));
  const session = root.authenticate(hello, oidcToken, new EffectsRunnerApi());
  return { root, session };
}

class EffectsRunnerApi extends RpcTarget implements RunnerCapability {
  execute(_action: RunnerActionV1): Promise<RunnerActionResultV1> { return Promise.reject(new Error("Effects job cannot execute planning actions")); }
  result(_operationId: string): Promise<RunnerActionResultV1 | null> { return Promise.resolve(null); }
  cancel(_operationId: string): Promise<void> { return Promise.resolve(); }
}

function safeClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void runEffectsMain();
