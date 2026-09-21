import { z } from "zod";

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const runnerHelloV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.hello/v1"),
  protocolVersion: z.literal("gardener.runner.rpc/v1"),
  phase: z.enum(["plan", "effects"]),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  ownerId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  runId: identifier,
  runAttempt: z.number().int().positive().max(1_000),
  workflowRef: z.string().min(1).max(1_024),
  jobWorkflowRef: z.string().min(1).max(1_024),
  eventName: z.enum(["issues", "workflow_dispatch"]),
  ref: z.string().min(1).max(1_024),
  runnerEnvironment: z.literal("github-hosted"),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  agentHash: sha256,
});

export const runnerActionV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.action/v1"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationId: identifier,
  kind: z.literal("shell.exec"),
  command: z.string().min(1).max(64 * 1024),
  cwd: z.string().min(1).max(4_096),
  timeoutMs: z.number().int().positive().max(10 * 60 * 1_000),
  maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024),
});

export const runnerActionResultV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.action-result/v1"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationId: identifier,
  status: z.enum(["completed", "failed", "cancelled", "timed_out"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  stdout: z.string().max(4 * 1024 * 1024),
  stderr: z.string().max(4 * 1024 * 1024),
  outputTruncated: z.boolean(),
}).superRefine((result, context) => {
  const processExited = result.status === "completed" || result.status === "failed";
  if (processExited !== (result.exitCode !== null)) {
    context.addIssue({
      code: "custom",
      path: ["exitCode"],
      message: processExited ? "Completed and failed commands require an exit code" : "Cancelled and timed-out commands cannot have an exit code",
    });
  }
});

export const runnerEventV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.event/v1"),
  kind: z.literal("github.issue.opened"),
  issue: z.strictObject({
    id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    number: z.number().int().positive(),
    title: z.string().max(1_024),
    body: z.string().max(65_536).nullable(),
    labels: z.array(z.string().trim().min(1).max(100)).max(100),
    author: z.strictObject({
      id: z.string().regex(/^[1-9][0-9]{0,19}$/),
      login: z.string().min(1).max(100),
    }),
  }),
});

export const runnerEffectReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.effect-receipt/v1"),
  planRunId: identifier,
  bundleHash: sha256,
  artifactSha256: sha256,
  operationId: identifier,
  kind: z.literal("issue.comment.create"),
  commentId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  commentUrl: z.url().refine(
    (value) => new URL(value).origin === "https://github.com",
    "Expected an HTTPS github.com comment URL",
  ),
});

export const runnerEffectArtifactV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.effect-artifact/v1"),
  sha256,
  bytesBase64: z.string().min(1).max(128 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});

export const runnerTerminalV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.terminal/v1"),
  status: z.enum(["completed", "failed", "cancelled"]),
  summary: z.string().min(1).max(16 * 1024),
  lastServerSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastCompletedSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  effectArtifact: runnerEffectArtifactV1Schema.optional(),
});

export const resumeCursorV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.cursor/v1"),
  lastServerSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastCompletedSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type RunnerHelloV1 = z.infer<typeof runnerHelloV1Schema>;
export type RunnerActionV1 = z.infer<typeof runnerActionV1Schema>;
export type RunnerActionResultV1 = z.infer<typeof runnerActionResultV1Schema>;
export type RunnerEventV1 = z.infer<typeof runnerEventV1Schema>;
export type RunnerEffectReceiptV1 = z.infer<typeof runnerEffectReceiptV1Schema>;
export type RunnerEffectArtifactV1 = z.infer<typeof runnerEffectArtifactV1Schema>;
export type RunnerTerminalV1 = z.infer<typeof runnerTerminalV1Schema>;
export type ResumeCursorV1 = z.infer<typeof resumeCursorV1Schema>;
