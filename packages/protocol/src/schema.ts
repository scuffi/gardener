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

export const runnerTerminalV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.terminal/v1"),
  status: z.enum(["completed", "failed", "cancelled"]),
  summary: z.string().min(1).max(16 * 1024),
  lastServerSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastCompletedSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const resumeCursorV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.cursor/v1"),
  lastServerSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastCompletedSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type RunnerHelloV1 = z.infer<typeof runnerHelloV1Schema>;
export type RunnerActionV1 = z.infer<typeof runnerActionV1Schema>;
export type RunnerActionResultV1 = z.infer<typeof runnerActionResultV1Schema>;
export type RunnerTerminalV1 = z.infer<typeof runnerTerminalV1Schema>;
export type ResumeCursorV1 = z.infer<typeof resumeCursorV1Schema>;
