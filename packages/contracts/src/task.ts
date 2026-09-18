import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$/);
const boundIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const githubNumericId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const repositoryFullName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201);
const relativePath = z.string().min(1).max(1_024).refine(
  (path) => !path.startsWith("/") && !path.endsWith("/") && !path.includes("\\")
    && path.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."),
  "expected a normalized repository-relative POSIX path",
);

export const taskTriggerV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("github.issue.opened"),
    labelsAll: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  }),
  z.strictObject({ kind: z.literal("github.workflow_dispatch") }),
]);
export type TaskTriggerV1 = z.infer<typeof taskTriggerV1Schema>;

export const taskToolV1Schema = z.enum([
  "repository.read_file",
  "repository.list_files",
  "repository.exec",
]);
export type TaskToolV1 = z.infer<typeof taskToolV1Schema>;

export const taskEffectKindV1Schema = z.enum([
  "issue.comment.create",
  "issue.labels.update",
  "repository.draft_pr.create",
]);
export type TaskEffectKindV1 = z.infer<typeof taskEffectKindV1Schema>;

export const taskLimitsV1Schema = z.strictObject({
  runtimeSeconds: z.number().int().positive().max(3_600),
  maxTurns: z.number().int().positive().max(32),
  maxToolCalls: z.number().int().positive().max(256),
  inputTokens: z.number().int().positive().max(1_000_000),
  outputTokens: z.number().int().positive().max(250_000),
});
export type TaskLimitsV1 = z.infer<typeof taskLimitsV1Schema>;

/**
 * Repository-independent executable semantics. Authoring formats compile to
 * this contract; the runtime never parses Markdown or YAML.
 */
export const taskBundleV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-bundle/v1"),
  taskId: identifier,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  instructions: z.string().trim().min(1).max(100_000),
  triggers: z.array(taskTriggerV1Schema).min(1).max(20),
  tools: z.array(taskToolV1Schema).max(taskToolV1Schema.options.length),
  effects: z.array(taskEffectKindV1Schema).max(taskEffectKindV1Schema.options.length),
  planningNetwork: z.literal("unrestricted"),
  limits: taskLimitsV1Schema,
}).superRefine((bundle, context) => {
  for (const key of ["tools", "effects"] as const) {
    if (new Set(bundle[key]).size !== bundle[key].length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} must be unique` });
    }
  }
  const triggers = bundle.triggers.map((trigger) => JSON.stringify(trigger));
  if (new Set(triggers).size !== triggers.length) {
    context.addIssue({ code: "custom", path: ["triggers"], message: "triggers must be unique" });
  }
  if (bundle.limits.outputTokens < bundle.limits.maxTurns * 16) {
    context.addIssue({ code: "custom", path: ["limits", "outputTokens"], message: "outputTokens must permit at least 16 tokens per model turn" });
  }
});
export type TaskBundleV1 = z.infer<typeof taskBundleV1Schema>;

const normalizedRepositoryV1Schema = z.strictObject({
  id: githubNumericId,
  ownerId: githubNumericId,
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  fullName: repositoryFullName,
  visibility: z.enum(["public", "private", "internal"]),
  commitSha: sha1,
  ref: z.string().min(1).max(1_024),
});

const normalizedWorkflowV1Schema = z.strictObject({
  runId: githubNumericId,
  runAttempt: z.number().int().positive().max(1_000),
  eventName: z.enum(["issues", "workflow_dispatch"]),
  workflowRef: z.string().min(1).max(1_024),
  jobWorkflowRef: z.string().min(1).max(1_024),
  runnerEnvironment: z.literal("github-hosted"),
});

const normalizedActorV1Schema = z.strictObject({
  id: githubNumericId,
  login: z.string().min(1).max(100),
});

const normalizedEventBase = {
  schemaVersion: z.literal("gardener.normalized-event/v1"),
  eventId: boundIdentifier,
  occurredAt: z.iso.datetime(),
  repository: normalizedRepositoryV1Schema,
  workflow: normalizedWorkflowV1Schema,
  actor: normalizedActorV1Schema,
};

export const normalizedEventV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...normalizedEventBase,
    kind: z.literal("github.issue.opened"),
    issue: z.strictObject({
      id: githubNumericId,
      number: z.number().int().positive(),
      title: z.string().max(1_024),
      body: z.string().max(65_536).nullable(),
      labels: z.array(z.string().trim().min(1).max(100)).max(100),
      author: normalizedActorV1Schema,
    }),
  }),
  z.strictObject({
    ...normalizedEventBase,
    kind: z.literal("github.workflow_dispatch"),
    prompt: z.string().trim().min(1).max(20_000),
  }),
]).superRefine((event, context) => {
  if (event.repository.fullName !== `${event.repository.owner}/${event.repository.name}`) {
    context.addIssue({ code: "custom", path: ["repository", "fullName"], message: "fullName must match repository owner and name" });
  }
  const expectedEventName = event.kind === "github.issue.opened" ? "issues" : "workflow_dispatch";
  if (event.workflow.eventName !== expectedEventName) {
    context.addIssue({ code: "custom", path: ["workflow", "eventName"], message: "workflow eventName does not match normalized event kind" });
  }
});
export type NormalizedEventV1 = z.infer<typeof normalizedEventV1Schema>;

export const taskRunRequestV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-run-request/v1"),
  runId: boundIdentifier,
  bundle: taskBundleV1Schema,
  bundleHash: sha256,
  policySnapshotHash: sha256,
  event: normalizedEventV1Schema,
  model: z.strictObject({ id: z.string().min(1).max(256) }),
  admittedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
}).superRefine((request, context) => {
  if (Date.parse(request.deadlineAt) <= Date.parse(request.admittedAt)) {
    context.addIssue({ code: "custom", path: ["deadlineAt"], message: "deadline must follow admission" });
  }
  if (request.event.repository.commitSha.length !== 40) {
    context.addIssue({ code: "custom", path: ["event", "repository", "commitSha"], message: "invalid commit binding" });
  }
});
export type TaskRunRequestV1 = z.infer<typeof taskRunRequestV1Schema>;

export const taskToolResultV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-tool-result/v1"),
  operationId: boundIdentifier,
  tool: taskToolV1Schema,
  status: z.enum(["completed", "failed", "cancelled", "timed_out"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  stdout: z.string().max(4 * 1_024 * 1_024),
  stderr: z.string().max(4 * 1_024 * 1_024),
  outputTruncated: z.boolean(),
}).superRefine((result, context) => {
  const exited = result.status === "completed" || result.status === "failed";
  if (exited !== (result.exitCode !== null)) {
    context.addIssue({ code: "custom", path: ["exitCode"], message: "exitCode must match process completion status" });
  }
});
export type TaskToolResultV1 = z.infer<typeof taskToolResultV1Schema>;

export const gitChangeArtifactRefV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.git-change-artifact/v1"),
  sha256,
  manifestSha256: sha256,
  sizeBytes: z.number().int().nonnegative().max(1_000_000_000),
});
export type GitChangeArtifactRefV1 = z.infer<typeof gitChangeArtifactRefV1Schema>;

export const proposedEffectV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    operationId: boundIdentifier,
    kind: z.literal("issue.comment.create"),
    issueNumber: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
    rationale: z.string().min(1).max(5_000),
  }),
  z.strictObject({
    operationId: boundIdentifier,
    kind: z.literal("issue.labels.update"),
    issueNumber: z.number().int().positive(),
    add: z.array(z.string().trim().min(1).max(100)).max(20),
    remove: z.array(z.string().trim().min(1).max(100)).max(20),
    rationale: z.string().min(1).max(5_000),
  }),
  z.strictObject({
    operationId: boundIdentifier,
    kind: z.literal("repository.draft_pr.create"),
    artifact: gitChangeArtifactRefV1Schema,
    branch: z.string().min(1).max(255),
    base: z.string().min(1).max(255),
    commitMessage: z.string().min(1).max(1_000),
    title: z.string().min(1).max(1_024),
    body: z.string().max(65_536),
    draft: z.literal(true),
    rationale: z.string().min(1).max(5_000),
  }),
]);
export type ProposedEffectV1 = z.infer<typeof proposedEffectV1Schema>;

/** Exact, hashable handoff consumed by the checkout-free effects job. */
export const taskEffectPlanV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-effect-plan/v1"),
  runId: boundIdentifier,
  taskId: identifier,
  bundleHash: sha256,
  repository: z.strictObject({ id: githubNumericId, fullName: repositoryFullName }),
  issueNumber: z.number().int().positive(),
  operationId: boundIdentifier,
  kind: z.literal("issue.comment.create"),
  body: z.string().min(1).max(65_536),
});
export type TaskEffectPlanV1 = z.infer<typeof taskEffectPlanV1Schema>;

export const taskObservationV1Schema = z.strictObject({
  kind: z.enum(["repository", "event", "test", "diagnostic"]),
  summary: z.string().trim().min(1).max(8_000),
  paths: z.array(relativePath).max(100).default([]),
});
export type TaskObservationV1 = z.infer<typeof taskObservationV1Schema>;

const taskOutcomeBase = {
  schemaVersion: z.literal("gardener.task-outcome/v1"),
  runId: boundIdentifier,
  taskId: identifier,
  bundleHash: sha256,
};

export const taskOutcomeV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    ...taskOutcomeBase,
    status: z.literal("completed"),
    summary: z.string().trim().min(1).max(32_000),
    observations: z.array(taskObservationV1Schema).max(200),
    proposedEffects: z.array(proposedEffectV1Schema).max(100),
  }),
  z.strictObject({
    ...taskOutcomeBase,
    status: z.literal("failed"),
    error: z.strictObject({ code: identifier, message: z.string().min(1).max(8_000), retryable: z.boolean() }),
  }),
  z.strictObject({
    ...taskOutcomeBase,
    status: z.literal("cancelled"),
    reason: z.string().min(1).max(8_000),
  }),
]);
export type TaskOutcomeV1 = z.infer<typeof taskOutcomeV1Schema>;
