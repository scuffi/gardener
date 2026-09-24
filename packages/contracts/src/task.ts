import { z } from "zod";
import {
  COMMIT_FILE_LIMIT,
  operationOutputRenderedMaxLength,
  operationKindValues,
  operationOutputNames,
  operationOutputSentinel,
  operationOutputType,
  operationSchema,
  type OperationKind,
  type OperationOutputType,
} from "./operations";

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

const taskLabelFilterV1Schema = z.array(z.string().trim().min(1).max(100)).max(20).default([]);

/** GitHub branch filter pattern accepted by `on.push.branches`. */
const branchFilterV1Schema = z.string().trim().min(1).max(255).regex(
  /^!?[A-Za-z0-9_.\-/*?+[\]]+$/,
  "expected a GitHub branch filter pattern",
);

/**
 * Inclusive numeric bounds for the five POSIX cron fields GitHub Actions
 * accepts, in field order.
 */
const CRON_FIELD_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/**
 * Conservative validator for the cron dialect GitHub Actions actually honours:
 * five numeric fields built from `*`, ranges, lists, and steps. Named months
 * and weekdays, `?`, `L`, `W`, and `#` are rejected because GitHub either
 * ignores them or refuses the workflow, and a silently-never-firing schedule is
 * indistinguishable from a broken task.
 */
function cronFieldIsValid(field: string, low: number, high: number): boolean {
  if (field.length === 0) return false;
  return field.split(",").every((item) => {
    if (item.length === 0) return false;
    const [range, step, ...excess] = item.split("/");
    if (excess.length > 0 || range === undefined) return false;
    if (step !== undefined) {
      if (!/^[0-9]{1,2}$/.test(step)) return false;
      const parsed = Number(step);
      if (parsed < 1 || parsed > high) return false;
    }
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2) return false;
    if (!bounds.every((bound) => /^[0-9]{1,2}$/.test(bound))) return false;
    const numbers = bounds.map(Number);
    if (numbers.some((value) => value < low || value > high)) return false;
    return numbers.length === 1 || numbers[0]! <= numbers[1]!;
  });
}

const cronExpressionV1Schema = z.string().trim().min(1).max(100).superRefine((value, context) => {
  const fields = value.split(" ");
  if (fields.length !== 5) {
    context.addIssue({ code: "custom", message: "expected a five-field cron expression" });
    return;
  }
  for (const [index, field] of fields.entries()) {
    const [low, high] = CRON_FIELD_BOUNDS[index]!;
    if (!cronFieldIsValid(field, low, high)) {
      context.addIssue({
        code: "custom",
        message: `cron field ${index + 1} must use numbers ${low}-${high}, ranges, lists, or steps`,
      });
    }
  }
});

function labelGatedTrigger<Kind extends string>(kind: Kind) {
  return z.strictObject({ kind: z.literal(kind), labelsAll: taskLabelFilterV1Schema });
}

/**
 * Portable repository event requirements. One member per (event, action) pair so
 * that every declared trigger compiles to an exact provider filter.
 */
export const taskTriggerV1Schema = z.discriminatedUnion("kind", [
  labelGatedTrigger("github.issue.opened"),
  labelGatedTrigger("github.issue.edited"),
  labelGatedTrigger("github.issue.labeled"),
  labelGatedTrigger("github.issue.unlabeled"),
  labelGatedTrigger("github.issue.reopened"),
  labelGatedTrigger("github.issue_comment.created"),
  labelGatedTrigger("github.pull_request.opened"),
  labelGatedTrigger("github.pull_request.reopened"),
  labelGatedTrigger("github.pull_request.synchronize"),
  labelGatedTrigger("github.pull_request.ready_for_review"),
  labelGatedTrigger("github.pull_request.converted_to_draft"),
  labelGatedTrigger("github.pull_request.edited"),
  labelGatedTrigger("github.pull_request.labeled"),
  labelGatedTrigger("github.pull_request.unlabeled"),
  labelGatedTrigger("github.pull_request_review.submitted"),
  labelGatedTrigger("github.pull_request_review_comment.created"),
  z.strictObject({
    kind: z.literal("github.push"),
    /**
     * At least one positive pattern is required. GitHub evaluates `branches`
     * as an allowlist, so an all-negative list matches nothing and the task
     * would never run.
     */
    branches: z.array(branchFilterV1Schema).min(1).max(20).refine(
      (branches) => branches.some((branch) => !branch.startsWith("!")),
      "push branches must include at least one positive pattern",
    ),
  }),
  z.strictObject({ kind: z.literal("github.workflow_dispatch") }),
  z.strictObject({ kind: z.literal("github.schedule"), cron: cronExpressionV1Schema }),
  labelGatedTrigger("github.discussion.created"),
  labelGatedTrigger("github.discussion.edited"),
  labelGatedTrigger("github.discussion.answered"),
  labelGatedTrigger("github.discussion.unanswered"),
  labelGatedTrigger("github.discussion.labeled"),
  labelGatedTrigger("github.discussion.unlabeled"),
  labelGatedTrigger("github.discussion_comment.created"),
]);
export type TaskTriggerV1 = z.infer<typeof taskTriggerV1Schema>;
export type TaskTriggerKindV1 = TaskTriggerV1["kind"];

/** Declaration order is canonical for compiled filters and generated workflows. */
export const taskTriggerKindValues = [
  "github.issue.opened",
  "github.issue.edited",
  "github.issue.labeled",
  "github.issue.unlabeled",
  "github.issue.reopened",
  "github.issue_comment.created",
  "github.pull_request.opened",
  "github.pull_request.reopened",
  "github.pull_request.synchronize",
  "github.pull_request.ready_for_review",
  "github.pull_request.converted_to_draft",
  "github.pull_request.edited",
  "github.pull_request.labeled",
  "github.pull_request.unlabeled",
  "github.pull_request_review.submitted",
  "github.pull_request_review_comment.created",
  "github.push",
  "github.workflow_dispatch",
  "github.schedule",
  "github.discussion.created",
  "github.discussion.edited",
  "github.discussion.answered",
  "github.discussion.unanswered",
  "github.discussion.labeled",
  "github.discussion.unlabeled",
  "github.discussion_comment.created",
] as const satisfies readonly TaskTriggerKindV1[];

/**
 * Compile-time exhaustiveness guard. If a member is added to the trigger union
 * without being ordered here, this alias resolves to `never` and fails the
 * build rather than silently dropping the kind from canonical ordering.
 */
type UnorderedTriggerKind = Exclude<TaskTriggerKindV1, (typeof taskTriggerKindValues)[number]>;
export type TriggerOrderingIsExhaustive = UnorderedTriggerKind extends never ? true : never;
export const triggerOrderingIsExhaustive: TriggerOrderingIsExhaustive = true;

/** Canonical position of a trigger kind, used to order compiled bundles. */
export const triggerKindOrder: ReadonlyMap<TaskTriggerKindV1, number> = new Map(
  taskTriggerKindValues.map((kind, index) => [kind, index]),
);

/** Triggers whose provider payload can reference a fork-owned head revision. */
export const pullRequestFamilyTriggerKindValues = taskTriggerKindValues.filter(
  (kind) => kind.startsWith("github.pull_request"),
);

/** Resources a manual run may target, by number. */
export const dispatchTargetKindValues = ["issue", "pull_request"] as const;
export type DispatchTargetKindV1 = typeof dispatchTargetKindValues[number];

/**
 * Resources a manual run of this bundle may target: those its other triggers
 * act on. An issue-triggered task can be run by hand against an issue, a pull
 * request task against a pull request.
 */
export function dispatchTargetKinds(triggers: readonly { kind: TaskTriggerKindV1 }[]): DispatchTargetKindV1[] {
  const kinds = new Set(triggers.map((trigger) => trigger.kind));
  const targets: DispatchTargetKindV1[] = [];
  if ([...kinds].some((kind) => kind.startsWith("github.issue"))) targets.push("issue");
  if ([...kinds].some((kind) => kind.startsWith("github.pull_request"))) targets.push("pull_request");
  return targets;
}

export const taskToolV1Schema = z.enum([
  "repository.read_file",
  "repository.list_files",
  "repository.exec",
  "provider.api.read",
]);
export type TaskToolV1 = z.infer<typeof taskToolV1Schema>;

/** Canonical effect authority vocabulary: exactly the persistent provider operations. */
export const taskEffectKindValues = operationKindValues;
export const taskEffectKindV1Schema = z.enum(taskEffectKindValues);
export type TaskEffectKindV1 = z.infer<typeof taskEffectKindV1Schema>;

const networkHostPattern = z.string().regex(
  /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "expected a lowercase DNS hostname or leading-wildcard hostname",
);

export const taskNetworkPolicyV1Schema = z.strictObject({
  default: z.enum(["deny", "allow"]),
  allow: z.array(networkHostPattern).max(64),
  deny: z.array(networkHostPattern).max(64),
}).superRefine((policy, context) => {
  for (const key of ["allow", "deny"] as const) {
    if (new Set(policy[key]).size !== policy[key].length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} hosts must be unique` });
    }
  }
});
export type TaskNetworkPolicyV1 = z.infer<typeof taskNetworkPolicyV1Schema>;

export const taskLimitsV1Schema = z.strictObject({
  runtimeSeconds: z.number().int().positive().max(3_600),
  maxTurns: z.number().int().positive().max(32),
  maxToolCalls: z.number().int().positive().max(256),
  inputTokens: z.number().int().positive().max(1_000_000),
  outputTokens: z.number().int().positive().max(250_000),
  /**
   * Optional task-authored effect-plan ceilings. When omitted Gardener adds no
   * product cap and only provider and runtime ceilings apply. When present both
   * planning and application fail closed.
   */
  maxEffectOperations: z.number().int().positive().max(1_000).optional(),
  maxEffectBytes: z.number().int().min(1_024).max(50_000_000).optional(),
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
  triggers: z.array(taskTriggerV1Schema).min(1).max(taskTriggerKindValues.length),
  tools: z.array(taskToolV1Schema).max(taskToolV1Schema.options.length),
  effects: z.array(taskEffectKindV1Schema).max(taskEffectKindV1Schema.options.length),
  network: taskNetworkPolicyV1Schema,
  limits: taskLimitsV1Schema,
  /**
   * A draft task runs only when dispatched by hand. Its other triggers are kept
   * so a manual run can still target the resource they describe, but no real
   * event starts it.
   */
  draft: z.literal(true).optional(),
}).superRefine((bundle, context) => {
  for (const key of ["tools", "effects"] as const) {
    if (new Set(bundle[key]).size !== bundle[key].length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} must be unique` });
    }
  }
  const triggerKinds = bundle.triggers.map((trigger) => trigger.kind);
  if (new Set(triggerKinds).size !== triggerKinds.length) {
    context.addIssue({ code: "custom", path: ["triggers"], message: "triggers must be unique" });
  }
  // Canonical ordering keeps the bundle hash and the generated workflow stable
  // regardless of the order the author listed triggers in.
  const positions = triggerKinds.map((kind) => triggerKindOrder.get(kind)!);
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["triggers"], message: "triggers must use canonical declaration order" });
  }
  if (!triggerKinds.includes("github.workflow_dispatch")) {
    context.addIssue({ code: "custom", path: ["triggers"], message: "every task must include the github.workflow_dispatch trigger" });
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
  /**
   * Default branch as GitHub reported it *in the triggering event payload*.
   *
   * Every exact operation embeds a repository identity, and that identity
   * includes the default branch. The value is taken from the bounded event
   * payload rather than read back from the API at apply time on purpose: the
   * default branch is mutable, so a later fetch could return a value that was
   * never true for this run and would silently change the canonical operation
   * hash — the same hash that commit trailers and receipts reconcile against.
   * Carrying the event's value keeps operation identity a function of the run.
   */
  defaultBranch: z.string().trim().min(1).max(255),
});

/** GitHub Actions event names Gardener admits. `pull_request_target` is excluded. */
export const normalizedEventNameV1Schema = z.enum([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "workflow_dispatch",
  "schedule",
  "discussion",
  "discussion_comment",
]);
export type NormalizedEventNameV1 = z.infer<typeof normalizedEventNameV1Schema>;

/**
 * Exact GitHub event name each portable trigger compiles to. This is the single
 * source of truth shared by the compiler, the OIDC admission check, and the
 * runtime trigger matcher, so the three can never disagree.
 */
export const eventNameByTriggerKind = {
  "github.issue.opened": "issues",
  "github.issue.edited": "issues",
  "github.issue.labeled": "issues",
  "github.issue.unlabeled": "issues",
  "github.issue.reopened": "issues",
  "github.issue_comment.created": "issue_comment",
  "github.pull_request.opened": "pull_request",
  "github.pull_request.reopened": "pull_request",
  "github.pull_request.synchronize": "pull_request",
  "github.pull_request.ready_for_review": "pull_request",
  "github.pull_request.converted_to_draft": "pull_request",
  "github.pull_request.edited": "pull_request",
  "github.pull_request.labeled": "pull_request",
  "github.pull_request.unlabeled": "pull_request",
  "github.pull_request_review.submitted": "pull_request_review",
  "github.pull_request_review_comment.created": "pull_request_review_comment",
  "github.push": "push",
  "github.workflow_dispatch": "workflow_dispatch",
  "github.schedule": "schedule",
  "github.discussion.created": "discussion",
  "github.discussion.edited": "discussion",
  "github.discussion.answered": "discussion",
  "github.discussion.unanswered": "discussion",
  "github.discussion.labeled": "discussion",
  "github.discussion.unlabeled": "discussion",
  "github.discussion_comment.created": "discussion_comment",
} as const satisfies Record<TaskTriggerKindV1, NormalizedEventNameV1>;

/**
 * `github.event.action` each trigger requires, when the event is
 * action-qualified. `push`, `schedule`, and `workflow_dispatch` carry none.
 */
export const eventActionByTriggerKind = {
  "github.issue.opened": "opened",
  "github.issue.edited": "edited",
  "github.issue.labeled": "labeled",
  "github.issue.unlabeled": "unlabeled",
  "github.issue.reopened": "reopened",
  "github.issue_comment.created": "created",
  "github.pull_request.opened": "opened",
  "github.pull_request.reopened": "reopened",
  "github.pull_request.synchronize": "synchronize",
  "github.pull_request.ready_for_review": "ready_for_review",
  "github.pull_request.converted_to_draft": "converted_to_draft",
  "github.pull_request.edited": "edited",
  "github.pull_request.labeled": "labeled",
  "github.pull_request.unlabeled": "unlabeled",
  "github.pull_request_review.submitted": "submitted",
  "github.pull_request_review_comment.created": "created",
  "github.push": null,
  "github.workflow_dispatch": null,
  "github.schedule": null,
  "github.discussion.created": "created",
  "github.discussion.edited": "edited",
  "github.discussion.answered": "answered",
  "github.discussion.unanswered": "unanswered",
  "github.discussion.labeled": "labeled",
  "github.discussion.unlabeled": "unlabeled",
  "github.discussion_comment.created": "created",
} as const satisfies Record<TaskTriggerKindV1, string | null>;

const normalizedWorkflowV1Schema = z.strictObject({
  runId: githubNumericId,
  runAttempt: z.number().int().positive().max(1_000),
  eventName: normalizedEventNameV1Schema,
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

const boundedLabels = z.array(z.string().trim().min(1).max(100)).max(100);
const boundedBody = z.string().max(65_536).nullable();

/** Opaque GraphQL node identifier, required to apply discussion operations. */
const githubNodeId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_=-]+$/);

const normalizedIssueV1Schema = z.strictObject({
  id: githubNumericId,
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: boundedBody,
  // Optional only for compatibility with explicitly pinned pre-field bridge
  // revisions. Current bridges always emit both; apply never trusts them.
  state: z.enum(["open", "closed"]).optional(),
  updatedAt: z.iso.datetime().optional(),
  labels: boundedLabels,
  author: normalizedActorV1Schema,
});

/**
 * Minimal repository identity for a pull-request side. `id` is the numeric
 * repository id, which is what same-repo enforcement compares; `fullName` is
 * carried only for messages and model context.
 */
const normalizedPullRequestRepositoryV1Schema = z.strictObject({
  id: githubNumericId,
  fullName: repositoryFullName,
});

const normalizedPullRequestV1Schema = z.strictObject({
  id: githubNumericId,
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: boundedBody,
  labels: boundedLabels,
  author: normalizedActorV1Schema,
  draft: z.boolean(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
  base: z.strictObject({
    ref: z.string().min(1).max(255),
    sha: sha1,
    repo: normalizedPullRequestRepositoryV1Schema,
  }),
  /**
   * Head revision identity. `repo` is nullable because GitHub omits it when the
   * fork has been deleted; a null head repository can never satisfy same-repo
   * enforcement, so the run fails closed.
   */
  head: z.strictObject({
    ref: z.string().min(1).max(255),
    sha: sha1,
    repo: normalizedPullRequestRepositoryV1Schema.nullable(),
  }),
});

const normalizedCommentV1Schema = z.strictObject({
  id: githubNumericId,
  body: boundedBody,
  updatedAt: z.iso.datetime().optional(),
  author: normalizedActorV1Schema,
});

const normalizedReviewV1Schema = z.strictObject({
  id: githubNumericId,
  state: z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]),
  body: boundedBody,
  author: normalizedActorV1Schema,
});

const normalizedDiscussionV1Schema = z.strictObject({
  id: githubNumericId,
  nodeId: githubNodeId,
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: boundedBody,
  labels: boundedLabels,
  author: normalizedActorV1Schema,
  category: z.string().min(1).max(100),
  answered: z.boolean(),
  state: z.enum(["open", "closed"]).optional(),
  updatedAt: z.iso.datetime().optional(),
});

const normalizedDiscussionCommentV1Schema = z.strictObject({
  id: githubNumericId,
  nodeId: githubNodeId,
  body: boundedBody,
  updatedAt: z.iso.datetime().optional(),
  author: normalizedActorV1Schema,
});

const normalizedPushV1Schema = z.strictObject({
  ref: z.string().min(1).max(1_024),
  before: sha1,
  after: sha1,
  forced: z.boolean(),
  /** Bounded commit summary; the full list is never carried into model context. */
  commits: z.array(z.strictObject({
    sha: sha1,
    message: z.string().max(4_096),
    author: z.strictObject({ name: z.string().max(200), email: z.string().max(320) }),
  })).max(20),
  /** Number of commits present in `commits`, which is never the push total. */
  includedCommits: z.number().int().min(0).max(20),
  /**
   * True when commits were dropped building this event. GitHub also caps its
   * own push payload, so `false` does not prove the push was small; use
   * `before`/`after` with the provider API when an exact range matters.
   */
  commitsTruncated: z.boolean(),
});

/** The single label GitHub attached or removed on a `labeled`/`unlabeled` event. */
const changedLabel = z.string().trim().min(1).max(100);

function eventMember<Kind extends TaskTriggerKindV1, Shape extends z.ZodRawShape>(kind: Kind, shape: Shape) {
  return z.strictObject({ ...normalizedEventBase, kind: z.literal(kind), ...shape });
}

const issuePayload = { issue: normalizedIssueV1Schema };
const pullRequestPayload = { pullRequest: normalizedPullRequestV1Schema };
const discussionPayload = { discussion: normalizedDiscussionV1Schema };

export const normalizedEventV1Schema = z.discriminatedUnion("kind", [
  eventMember("github.issue.opened", issuePayload),
  eventMember("github.issue.edited", issuePayload),
  eventMember("github.issue.labeled", { ...issuePayload, label: changedLabel }),
  eventMember("github.issue.unlabeled", { ...issuePayload, label: changedLabel }),
  eventMember("github.issue.reopened", issuePayload),
  eventMember("github.issue_comment.created", { ...issuePayload, comment: normalizedCommentV1Schema }),
  eventMember("github.pull_request.opened", pullRequestPayload),
  eventMember("github.pull_request.reopened", pullRequestPayload),
  eventMember("github.pull_request.synchronize", pullRequestPayload),
  eventMember("github.pull_request.ready_for_review", pullRequestPayload),
  eventMember("github.pull_request.converted_to_draft", pullRequestPayload),
  eventMember("github.pull_request.edited", pullRequestPayload),
  eventMember("github.pull_request.labeled", { ...pullRequestPayload, label: changedLabel }),
  eventMember("github.pull_request.unlabeled", { ...pullRequestPayload, label: changedLabel }),
  eventMember("github.pull_request_review.submitted", { ...pullRequestPayload, review: normalizedReviewV1Schema }),
  eventMember("github.pull_request_review_comment.created", { ...pullRequestPayload, comment: normalizedCommentV1Schema }),
  eventMember("github.push", { push: normalizedPushV1Schema }),
  eventMember("github.workflow_dispatch", {
    prompt: z.string().trim().min(1).max(20_000).optional(),
    // A manual run may name one issue or pull request to act on.
    issue: normalizedIssueV1Schema.optional(),
    pullRequest: normalizedPullRequestV1Schema.optional(),
  }),
  eventMember("github.schedule", { cron: cronExpressionV1Schema }),
  eventMember("github.discussion.created", discussionPayload),
  eventMember("github.discussion.edited", discussionPayload),
  eventMember("github.discussion.answered", discussionPayload),
  eventMember("github.discussion.unanswered", discussionPayload),
  eventMember("github.discussion.labeled", { ...discussionPayload, label: changedLabel }),
  eventMember("github.discussion.unlabeled", { ...discussionPayload, label: changedLabel }),
  eventMember("github.discussion_comment.created", { ...discussionPayload, comment: normalizedDiscussionCommentV1Schema }),
]).superRefine((event, context) => {
  if (event.repository.fullName !== `${event.repository.owner}/${event.repository.name}`) {
    context.addIssue({ code: "custom", path: ["repository", "fullName"], message: "fullName must match repository owner and name" });
  }
  if (event.workflow.eventName !== eventNameByTriggerKind[event.kind]) {
    context.addIssue({ code: "custom", path: ["workflow", "eventName"], message: "workflow eventName does not match normalized event kind" });
  }
  if (event.kind === "github.workflow_dispatch" && event.issue !== undefined && event.pullRequest !== undefined) {
    context.addIssue({ code: "custom", path: ["pullRequest"], message: "a manual run may target an issue or a pull request, not both" });
  }
  if (event.kind === "github.push" && event.push.ref !== event.repository.ref) {
    context.addIssue({ code: "custom", path: ["push", "ref"], message: "push ref must match the bound repository ref" });
  }
});
export type NormalizedEventV1 = z.infer<typeof normalizedEventV1Schema>;
export type NormalizedPullRequestV1 = z.infer<typeof normalizedPullRequestV1Schema>;

/** Narrowed accessor for the pull-request payload, when the event carries one. */
export function normalizedPullRequest(event: NormalizedEventV1): NormalizedPullRequestV1 | undefined {
  return "pullRequest" in event ? event.pullRequest : undefined;
}

/**
 * Same-repository enforcement. Gardener V1 never executes a head revision that
 * is not owned by the enrolled repository, so fork pull requests fail closed
 * with no author-facing opt-in.
 */
export function eventHeadIsSameRepository(event: NormalizedEventV1): boolean {
  const pullRequest = normalizedPullRequest(event);
  if (pullRequest === undefined) return true;
  return pullRequest.head.repo !== null && pullRequest.head.repo.id === event.repository.id;
}

export const taskRunRequestV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-run-request/v1"),
  runId: boundIdentifier,
  bundle: taskBundleV1Schema,
  bundleHash: sha256,
  sourcePath: relativePath,
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

/* -------------------------------------------------------------------------- */
/* Ordered effect proposals and plans                                         */
/* -------------------------------------------------------------------------- */

/**
 * Model-supplied name for one step of an ordered plan. Lowercase and short so
 * it reads well in a receipt, unique within a plan, and stable enough to be
 * folded into the derived operation id.
 */
export const taskStepNameV1Schema = z.string().regex(
  /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/,
  "expected a lowercase step name such as \"comment\" or \"open-draft\"",
).max(63);
export type TaskStepNameV1 = z.infer<typeof taskStepNameV1Schema>;

/** Field names an operation publishes; matches the contracts output catalog. */
const taskOutputNameV1Schema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);

/**
 * Object keys that reach `Object.prototype` when used as a plain property
 * write. Model-authored payloads and pointers are attacker-controlled JSON, so
 * these are rejected outright at every depth rather than stripped: silently
 * dropping a key discards intent without telling anyone, and a dropped
 * `__proto__` still means the model asked for something Gardener refused.
 */
export const prototypePollutingKeys = ["__proto__", "constructor", "prototype"] as const;
const prototypePollutingKeySet: ReadonlySet<string> = new Set(prototypePollutingKeys);

/** True when a key or pointer segment can reach the prototype chain. */
export function isPrototypePollutingKey(key: string): boolean {
  return prototypePollutingKeySet.has(key);
}

/**
 * RFC 6901 JSON pointer into a step payload. Bounded and non-empty: a plan
 * never substitutes a value for the whole payload. No segment may name a
 * prototype-reaching key, so a reference can never be used to walk out of the
 * payload and into `Object.prototype`.
 */
export const taskPayloadPointerV1Schema = z.string()
  .min(2)
  .max(256)
  .regex(/^(?:\/(?:[^~/]|~[01])*)+$/, "expected an RFC 6901 JSON pointer such as \"/body\"")
  .superRefine((pointer, context) => {
    for (const segment of decodeJsonPointer(pointer)) {
      if (isPrototypePollutingKey(segment)) {
        context.addIssue({ code: "custom", message: `pointer segment "${segment}" is not addressable` });
      }
    }
  });

/** Payload keys a plan owns, which a model may never supply or reference. */
const reservedPayloadKeys = ["schemaVersion", "id", "repository", "kind"] as const;
const reservedPayloadKeySet: ReadonlySet<string> = new Set(reservedPayloadKeys);

export type TaskJsonValueV1 =
  | string
  | number
  | boolean
  | null
  | readonly TaskJsonValueV1[]
  | { readonly [key: string]: TaskJsonValueV1 };

const MAX_PAYLOAD_DEPTH = 12;
const MAX_PAYLOAD_BYTES = 1_024 * 1_024;
const MAX_PAYLOAD_NODES = 100_000;

const taskJsonValueV1Schema: z.ZodType<TaskJsonValueV1> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(taskJsonValueV1Schema),
  z.record(z.string(), taskJsonValueV1Schema),
]));

/**
 * Byte length of the canonical JSON encoding, which is what gets hashed and
 * shipped. Returns `null` for anything JSON cannot encode (a cycle, or a
 * structure deep enough to overflow the serializer) so callers can fail closed
 * instead of catching a `RangeError` from inside a validator.
 */
export function canonicalJsonByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return new TextEncoder().encode(encoded).length;
  } catch {
    return null;
  }
}

/**
 * Iterative structural gate run *before* any recursive schema touches the
 * value.
 *
 * Zod validates a recursive union by recursing, and `JSON.stringify` recurses
 * too, so a sufficiently nested payload throws `RangeError` out of `safeParse`
 * before a depth check written as a `superRefine` ever executes. Walking the
 * value with an explicit stack is what makes "too deep" a validation failure
 * rather than a crash.
 */
function inspectJsonStructure(root: unknown): readonly string[] {
  const issues: string[] = [];
  const ancestors = new Set<object>();
  const stack: { value: unknown; depth: number; enter: boolean }[] = [{ value: root, depth: 1, enter: true }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop() as { value: unknown; depth: number; enter: boolean };
    const { value, depth } = frame;

    if (!frame.enter) {
      ancestors.delete(value as object);
      continue;
    }
    if (issues.length > 0) break;

    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      issues.push(`payload contains more than ${MAX_PAYLOAD_NODES} values`);
      break;
    }
    if (depth > MAX_PAYLOAD_DEPTH) {
      issues.push(`payload nests deeper than ${MAX_PAYLOAD_DEPTH} levels`);
      break;
    }

    if (value === null) continue;
    const type = typeof value;
    if (type === "string" || type === "boolean") continue;
    if (type === "number") {
      if (!Number.isFinite(value)) issues.push("payload contains a non-finite number");
      continue;
    }
    if (type !== "object") {
      issues.push(`payload contains a ${type} value, which JSON cannot represent`);
      continue;
    }

    const container = value as object;
    if (ancestors.has(container)) {
      issues.push("payload contains a circular reference");
      break;
    }
    ancestors.add(container);
    stack.push({ value: container, depth, enter: false });

    if (Array.isArray(container)) {
      for (const item of container) stack.push({ value: item, depth: depth + 1, enter: true });
      continue;
    }
    for (const key of Reflect.ownKeys(container)) {
      if (typeof key === "symbol") {
        issues.push("payload contains a symbol key, which JSON cannot represent");
        break;
      }
      if (isPrototypePollutingKey(key)) {
        issues.push(`payload may not contain the key "${key}"`);
        break;
      }
      stack.push({ value: (container as Record<string, unknown>)[key], depth: depth + 1, enter: true });
    }
  }
  return issues;
}

/**
 * The model-authored field set of one operation, minus everything the plan
 * owns.
 *
 * The iterative gate runs first through a pipe so a hostile value is rejected
 * before the recursive typed parse can recurse into it. File contents never
 * travel here; they are materialized at apply time from the capture artifact.
 */
export const taskEffectPayloadV1Schema = z.unknown()
  .superRefine((payload, context) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      context.addIssue({ code: "custom", message: "payload must be a JSON object" });
      return;
    }
    for (const message of inspectJsonStructure(payload)) {
      context.addIssue({ code: "custom", message });
      return;
    }
    for (const key of Object.keys(payload)) {
      if (reservedPayloadKeySet.has(key)) {
        context.addIssue({ code: "custom", path: [key], message: `payload may not set the plan-owned field ${key}` });
      }
    }
    const bytes = canonicalJsonByteLength(payload);
    if (bytes === null) {
      context.addIssue({ code: "custom", message: "payload cannot be canonically serialized" });
      return;
    }
    if (bytes > MAX_PAYLOAD_BYTES) {
      context.addIssue({ code: "custom", message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` });
    }
  })
  .pipe(z.record(z.string().max(64), taskJsonValueV1Schema));

/** Typed pointer from an earlier step's scalar output. */
export const taskStepOutputRefV1Schema = z.strictObject({
  step: taskStepNameV1Schema,
  output: taskOutputNameV1Schema,
});
export type TaskStepOutputRefV1 = z.infer<typeof taskStepOutputRefV1Schema>;

const MAX_STEP_REFERENCES = 32;
const MAX_FIELD_PLACEHOLDERS = 8;
const placeholderNamePattern = "[a-z][a-z0-9_]{0,31}";

/** Name of a placeholder, written in text as `{{name}}`. */
export const taskPlaceholderNameV1Schema = z.string().regex(new RegExp(`^${placeholderNamePattern}$`));

/**
 * Earlier-step outputs spliced into model-written text. The text at the
 * reference's pointer contains `{{name}}` for each placeholder, and apply
 * replaces every occurrence with the output's value.
 */
export const taskStepTemplateRefV1Schema = z.strictObject({
  placeholders: z.record(taskPlaceholderNameV1Schema, taskStepOutputRefV1Schema).superRefine((placeholders, context) => {
    const count = Object.keys(placeholders).length;
    if (count === 0 || count > MAX_FIELD_PLACEHOLDERS) {
      context.addIssue({ code: "custom", message: `a field may declare between 1 and ${MAX_FIELD_PLACEHOLDERS} placeholders` });
    }
  }),
});
export type TaskStepTemplateRefV1 = z.infer<typeof taskStepTemplateRefV1Schema>;

/** A whole-field output, or outputs spliced into text at that field. */
export const taskStepReferenceV1Schema = z.union([taskStepOutputRefV1Schema, taskStepTemplateRefV1Schema]);
export type TaskStepReferenceV1 = z.infer<typeof taskStepReferenceV1Schema>;

export function isTemplateReference(reference: TaskStepReferenceV1): reference is TaskStepTemplateRefV1 {
  return Object.hasOwn(reference, "placeholders");
}

/** Every earlier-step output a reference consumes, with the placeholder it fills, if any. */
export function referenceOutputs(
  reference: TaskStepReferenceV1,
): ReadonlyArray<{ readonly placeholder?: string; readonly output: TaskStepOutputRefV1 }> {
  return isTemplateReference(reference)
    ? Object.entries(reference.placeholders).map(([placeholder, output]) => ({ placeholder, output }))
    : [{ output: reference }];
}

/** The text form of a placeholder. */
export function placeholderToken(name: string): string {
  return `{{${name}}}`;
}

/**
 * Replaces each `{{name}}` that has a value, in one pass over the original
 * text, so a substituted value is never itself scanned for placeholders.
 * Anything else in braces is left as written.
 */
export function renderPlaceholders(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(new RegExp(`\\{\\{(${placeholderNamePattern})\\}\\}`, "g"), (token, name: string) =>
    values.get(name) ?? token);
}

/**
 * Substitutions applied to a payload immediately before the step runs, keyed by
 * the JSON pointer they fill. Kept out of the payload itself so an unresolved
 * reference can never be mistaken for a literal value.
 */
export const taskStepReferencesV1Schema = z.record(taskPayloadPointerV1Schema, taskStepReferenceV1Schema)
  .superRefine((references, context) => {
    const pointers = Object.keys(references);
    const outputs = Object.values(references).reduce((total, reference) => total + referenceOutputs(reference).length, 0);
    if (outputs > MAX_STEP_REFERENCES) {
      context.addIssue({ code: "custom", message: `a step may reference at most ${MAX_STEP_REFERENCES} earlier-step outputs` });
    }
    // One reference inside another would be read before substitution when
    // planning but after it when applying, so the two could disagree.
    for (const pointer of pointers) {
      const enclosing = pointers.find((other) => other !== pointer && pointer.startsWith(`${other}/`));
      if (enclosing !== undefined) {
        context.addIssue({ code: "custom", path: [pointer], message: `reference ${pointer} is inside reference ${enclosing}` });
      }
    }
    for (const pointer of pointers) {
      const [head] = decodeJsonPointer(pointer);
      if (head !== undefined && reservedPayloadKeySet.has(head)) {
        context.addIssue({ code: "custom", path: [pointer], message: `references may not target the plan-owned field ${head}` });
      }
    }
  });

/** Splits an RFC 6901 pointer into decoded segments. */
export function decodeJsonPointer(pointer: string): readonly string[] {
  return pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Renders a Zod issue path as an RFC 6901 pointer so it can be matched against references. */
export function encodeJsonPointer(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${String(segment).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/**
 * One ordered step exactly as the model proposed it.
 *
 * There is deliberately no `operationId`: an id the model chose would not be
 * derivable from the run, and a model that can choose ids can collide with a
 * previous attempt's receipt and suppress a real effect. Gardener derives every
 * id from the run, the step order, the step name, and the canonical payload.
 */
export const taskEffectProposalV1Schema = z.strictObject({
  stepName: taskStepNameV1Schema,
  kind: taskEffectKindV1Schema,
  payload: taskEffectPayloadV1Schema,
  references: taskStepReferencesV1Schema.default({}),
  rationale: z.string().trim().min(1).max(5_000),
}).superRefine((proposal, context) => {
  // Repository file bytes are capture-owned. A proposal must omit them, and
  // trying to supply them is refused here rather than silently accepted as a
  // second, capture-free way to write a commit.
  for (const message of captureOwnedPointerIssues(proposal.kind, proposal.payload, proposal.references)) {
    context.addIssue({ code: "custom", path: ["payload"], message });
  }
  // Those same pointers are always deferred, so the probe validates every
  // field the model did supply while staying silent about the one only a
  // trusted capture may fill. Omission is not permission: the plan still
  // refuses to carry such a step unless a real capture was admitted.
  for (const issue of probeOperationShape({
    ...proposal,
    deferredPointers: captureDeferredPointers(proposal.kind),
  })) {
    context.addIssue({ code: "custom", path: ["payload"], message: issue });
  }
});
export type TaskEffectProposalV1 = z.infer<typeof taskEffectProposalV1Schema>;


/* -------------------------------------------------------------------------- */
/* Probe validation                                                           */
/* -------------------------------------------------------------------------- */

const PROBE_REPOSITORY = { provider: "github", id: "1", owner: "gardener", name: "probe", defaultBranch: "main" } as const;
const PROBE_OPERATION_ID = "gardener-probe";
const PROBE_UNTYPED_SENTINEL = "gardener-step-output";

/**
 * Highest array index a reference pointer may address.
 *
 * Operation payload arrays are small and already bounded by `operationSchema`:
 * the largest are `commit.create.files`, `pull_request.review.submit.comments`,
 * and `pull_request.merge.requiredChecks` at 100 entries, and
 * `pull_request.reviewer.*.reviewerIds` at 15. An index past the largest of
 * those can never address a valid location, so refusing it costs nothing.
 *
 * Without this bound a pointer is a memory amplifier: `/files/999999999`
 * makes `setPointer` materialize a sparse array whose length the operation
 * schema then walks, so a single short model-authored string turns into a
 * multi-gigabyte parse. Measured before this guard: `/files/1000000` returned
 * 1,000,001 issues, and `/files/999999999` exhausted the heap and killed the
 * process from inside `safeParse`.
 */
const MAX_POINTER_ARRAY_INDEX = 99;

/**
 * Highest number of probe messages one step reports.
 *
 * A payload may legitimately carry thousands of values, and a single wrong
 * element type can make the operation schema report an issue for every one of
 * them. The proposal only needs enough detail to be repaired, and an unbounded
 * issue list is itself the denial-of-service, so the list is truncated and the
 * truncation is stated.
 */
const MAX_PROBE_MESSAGES = 32;

/**
 * Reads the value at an RFC 6901 pointer using own properties only, or
 * `undefined` when the pointer does not address a present value.
 */
export function readPayloadPointer(root: unknown, pointer: string): unknown {
  const segments = decodeJsonPointer(pointer);
  if (segments.length === 0 || segments.some(isPrototypePollutingKey)) return undefined;
  let cursor: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(cursor)) {
      const position = arrayIndex(segment);
      if (position === null) return undefined;
      cursor = cursor[position];
    } else if (cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, segment)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Writes a value at a pointer inside a throwaway probe object.
 *
 * Every segment is refused if it can reach the prototype chain, traversal only
 * follows *own* properties, and intermediates are created with a null
 * prototype. A pointer is attacker-controlled text, so a plain `record[segment]`
 * walk here would let `/__proto__/x` write to `Object.prototype` and corrupt
 * every later parse in the process, including Zod's own internals.
 */
function setPointer(root: Record<string, unknown>, segments: readonly string[], value: unknown): boolean {
  if (segments.length === 0) return false;
  if (segments.some(isPrototypePollutingKey)) return false;

  let cursor: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const lookahead = segments[index + 1] as string;
    const seed: unknown = /^(?:0|[1-9][0-9]*)$/.test(lookahead) ? [] : Object.create(null);
    if (Array.isArray(cursor)) {
      const position = arrayIndex(segment);
      if (position === null) return false;
      if (cursor[position] === undefined) cursor[position] = seed;
      cursor = cursor[position];
      continue;
    }
    if (cursor === null || typeof cursor !== "object") return false;
    const record = cursor as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) {
      Object.defineProperty(record, segment, { value: seed, writable: true, enumerable: true, configurable: true });
    }
    cursor = record[segment];
  }

  const last = segments[segments.length - 1] as string;
  if (Array.isArray(cursor)) {
    const position = arrayIndex(last);
    if (position === null) return false;
    cursor[position] = value;
    return true;
  }
  if (cursor === null || typeof cursor !== "object") return false;
  Object.defineProperty(cursor, last, { value, writable: true, enumerable: true, configurable: true });
  return true;
}

/**
 * Decodes an array position, refusing anything a real operation payload could
 * not hold. A refused index makes `setPointer` report that the pointer does
 * not address a payload location, which is the same outcome as any other
 * unaddressable pointer.
 */
function arrayIndex(segment: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return null;
  const position = Number(segment);
  if (!Number.isInteger(position) || position < 0 || position > MAX_POINTER_ARRAY_INDEX) return null;
  return position;
}

/**
 * Deep copy that keeps only JSON-shaped own data. Used instead of
 * `structuredClone` so the probe candidate is built from a known-safe shape
 * and never carries an inherited or exotic property into the parser.
 */
function safeJsonClone(value: unknown, depth = 0): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => safeJsonClone(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isPrototypePollutingKey(key)) continue;
    copy[key] = safeJsonClone((value as Record<string, unknown>)[key], depth + 1);
  }
  return copy;
}

export interface ProbeOperationShapeInput {
  readonly kind: TaskEffectKindV1;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly references?: Readonly<Record<string, TaskStepReferenceV1>>;
  /**
   * Pointers whose value is supplied at apply time rather than by the model,
   * such as the `commit.create` file set materialized from the capture
   * artifact.
   */
  readonly deferredPointers?: readonly string[];
  /** Resolves a reference to its output type so a correctly-typed sentinel can be used. */
  readonly resolveOutputType?: (reference: TaskStepOutputRefV1) => OperationOutputType | undefined;
}

/**
 * Validates a proposed step against the real operation schema without waiting
 * for apply time.
 *
 * A pending reference has no value yet, so the probe fills it with a typed
 * sentinel and then discards any issue reported at or beneath a deferred
 * pointer. Discarding is what makes this sound: no sentinel can satisfy every
 * validator a field might carry (`draft` is `literal(true)` for one kind and
 * `literal(false)` for another), so correctness comes from ignoring those
 * positions, not from guessing them. Everything the model did supply is still
 * held to the exact contract.
 */
export function probeOperationShape(step: ProbeOperationShapeInput): readonly string[] {
  const messages: string[] = [];
  const candidate: Record<string, unknown> = {
    ...safeJsonClone(step.payload) as Record<string, unknown>,
    schemaVersion: "v2",
    id: PROBE_OPERATION_ID,
    repository: PROBE_REPOSITORY,
    kind: step.kind,
  };
  const deferred = new Set<string>(step.deferredPointers ?? []);
  const wholeField = new Set<string>();
  for (const [pointer, reference] of Object.entries(step.references ?? {})) {
    if (isTemplateReference(reference)) {
      // With every placeholder typed, the text is validated at the longest it
      // can render, so its field's own limits hold for any real value. Without
      // types (a proposal checked before its ledger is known) it is deferred
      // like a whole-field reference and validated once the types are known.
      const template = readPayloadPointer(step.payload, pointer);
      const lengths = new Map<string, string>();
      for (const [name, output] of Object.entries(reference.placeholders)) {
        const type = step.resolveOutputType?.(output);
        if (type !== undefined) lengths.set(name, "x".repeat(operationOutputRenderedMaxLength(type)));
      }
      if (typeof template === "string" && lengths.size === Object.keys(reference.placeholders).length) {
        if (!setPointer(candidate, decodeJsonPointer(pointer), renderPlaceholders(template, lengths))) {
          messages.push(`reference pointer ${pointer} does not address a payload location`);
        }
      } else {
        deferred.add(pointer);
      }
      continue;
    }
    deferred.add(pointer);
    wholeField.add(pointer);
    const type = step.resolveOutputType?.(reference);
    const sentinel = type === undefined ? PROBE_UNTYPED_SENTINEL : operationOutputSentinel(type);
    if (!setPointer(candidate, decodeJsonPointer(pointer), sentinel)) {
      messages.push(`reference pointer ${pointer} does not address a payload location`);
    }
  }

  // The probe runs against a model-authored value. Any throw here — a recursion
  // limit, or a validator that assumed a shape — would escape a `safeParse`
  // further out and turn a rejected proposal into a crashed run, so the whole
  // parse is contained and reported as a validation failure.
  let probed: ReturnType<typeof operationSchema.safeParse>;
  try {
    probed = operationSchema.safeParse(candidate);
  } catch (cause) {
    messages.push(`operation: payload could not be validated (${cause instanceof Error ? cause.name : "unknown error"})`);
    return messages;
  }
  if (probed.success) return messages;
  let suppressed = 0;
  for (const issue of probed.error.issues) {
    const pointer = encodeJsonPointer(issue.path);
    // Every output is a scalar, so a whole-field reference to a position that
    // must hold an object or an array can never materialize, whatever value
    // the step produces. Unlike other issues at a reference, that one is real.
    const scalarIntoStructure = wholeField.has(pointer)
      && issue.code === "invalid_type"
      && (issue.expected === "object" || issue.expected === "array" || issue.expected === "record");
    const isDeferred = pointer !== ""
      && [...deferred].some((prefix) => pointer === prefix || pointer.startsWith(`${prefix}/`));
    if (isDeferred && !scalarIntoStructure) continue;
    if (messages.length >= MAX_PROBE_MESSAGES) {
      suppressed += 1;
      continue;
    }
    messages.push(`${pointer === "" ? "operation" : pointer}: ${issue.message}`);
  }
  if (suppressed > 0) messages.push(`operation: ${suppressed} further problems were not reported`);
  return messages;
}

/* -------------------------------------------------------------------------- */
/* Repository change capture                                                  */
/* -------------------------------------------------------------------------- */

/** Blob modes Git records for a regular tree entry. Submodules are not capturable. */
export const taskCaptureFileModeV1Schema = z.enum(["100644", "100755", "120000"]);

/**
 * Largest single captured file, in bytes.
 *
 * Every captured byte is eventually written through the Git Data blob
 * endpoint, and GitHub refuses a blob — and a pushed file — larger than
 * 100 MiB. A capture describing a larger file could never be applied, so the
 * manifest refuses it at plan time instead of failing mid-apply with part of
 * the plan already executed. This is the provider's number, not one invented
 * here.
 */
export const CAPTURE_FILE_MAX_BYTES = 100 * 1_024 * 1_024;

/**
 * Largest total capture, in bytes.
 *
 * Derived rather than invented: the capture is applied through `commit.create`
 * steps, whose `files` array is capped at 100 entries by `operationSchema`, and
 * each entry is bounded by `CAPTURE_FILE_MAX_BYTES` above. The product is the
 * largest capture a single commit could ever materialize, so it is the widest
 * honest ceiling for the manifest and its ref.
 *
 * Note this intentionally does not encode a GitHub Actions artifact ceiling:
 * GitHub bounds artifacts by the account's storage quota rather than a fixed
 * documented per-artifact byte count, so citing one would be inventing it.
 */
export const CAPTURE_TOTAL_MAX_BYTES = 100 * CAPTURE_FILE_MAX_BYTES;

/** Per-file byte count, bounded by what the provider will accept as one blob. */
const fileByteCount = z.number().int().nonnegative().max(CAPTURE_FILE_MAX_BYTES);

/** Aggregate byte count, bounded by the largest capture a commit could apply. */
const captureByteCount = z.number().int().nonnegative().max(CAPTURE_TOTAL_MAX_BYTES);

/**
 * Repository paths a captured change may never write.
 *
 * A `commit.create` step whose `files` are materialized from the capture never
 * lists those paths in its payload, so the instance policy's path check has
 * nothing to inspect at plan time. Writing a workflow, a composite action, or
 * the task definitions themselves would let a run rewrite the authority that
 * governs the next run, so those prefixes are refused in the manifest — the
 * one place where the full path set is known before anything is applied.
 */
export const protectedCapturePathPrefixes = [
  ".git/",
  ".github/workflows/",
  ".github/actions/",
  ".gardener/",
] as const;

/**
 * Exact protected files.
 *
 * CODEOWNERS decides who must approve a change, so a run that could rewrite it
 * could approve its own future work. GitHub resolves CODEOWNERS from exactly
 * three locations, so all three are refused. `dependabot.yml` is refused for
 * the same reason in a different guise: it directs an automation that opens
 * pull requests, so a run that could rewrite it could arrange future writes it
 * was never granted. Both spellings GitHub accepts are listed.
 */
export const protectedCapturePaths = [
  "CODEOWNERS",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
  "docs/CODEOWNERS",
] as const;

/**
 * True when a captured path would rewrite Gardener's or Actions' own authority.
 *
 * Matching is case-insensitive. A checkout on a case-insensitive filesystem
 * resolves `.GitHub/Workflows/ci.yml` to the same file as the protected path,
 * and GitHub itself treats the CODEOWNERS filename case-insensitively, so a
 * case-sensitive comparison here would be bypassable by changing one letter.
 */
export function isProtectedCapturePath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (protectedCapturePaths.some((protectedPath) => normalized === protectedPath.toLowerCase())) return true;
  return protectedCapturePathPrefixes.some((prefix) => {
    const lowered = prefix.toLowerCase();
    return normalized === lowered.slice(0, -1) || normalized.startsWith(lowered);
  });
}

/**
 * One captured path. File bytes are deliberately absent: the manifest travels
 * inside the plan, which is read by the privileged apply job, while the bytes
 * stay in the separate changes artifact that is only ever streamed to the Git
 * Data API. A digest per file is what lets apply prove it wrote what planning
 * captured.
 */
export const taskCaptureFileV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    path: relativePath,
    status: z.enum(["added", "modified"]),
    mode: taskCaptureFileModeV1Schema,
    sizeBytes: fileByteCount,
    sha256,
  }),
  z.strictObject({
    path: relativePath,
    status: z.literal("deleted"),
  }),
]);
export type TaskCaptureFileV1 = z.infer<typeof taskCaptureFileV1Schema>;

/**
 * Per-path capture metadata, carried inside the plan.
 *
 * The file count shares `commit.create`'s `COMMIT_FILE_LIMIT`, so every
 * admitted capture can be materialized. The byte ceilings are the provider's
 * own (`CAPTURE_FILE_MAX_BYTES`) and the largest capture a commit could
 * materialize (`CAPTURE_TOTAL_MAX_BYTES`), and the manifest itself still has to
 * fit inside the plan's canonical transport ceiling alongside the task's
 * optional `maxEffectOperations` and `maxEffectBytes`.
 */
export const taskCaptureManifestV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-capture-manifest/v1"),
  captureId: boundIdentifier,
  /** Commit the capture was taken against; apply refuses a drifted base. */
  baseSha: sha1,
  /**
   * Bounded by the number of files one `commit.create` may write. A larger
   * capture could never be materialized, so it is refused when the capture is
   * admitted, before a plan exists, rather than partway through apply.
   */
  files: z.array(taskCaptureFileV1Schema).min(1).max(COMMIT_FILE_LIMIT),
  totalBytes: captureByteCount,
  /**
   * A partial capture is never applicable, so the only representable value is
   * `false`. Capture that hits a limit must fail the run, not ship a subset of
   * the change the model believed it was making.
   */
  truncated: z.literal(false),
}).superRefine((manifest, context) => {
  const paths = manifest.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "captured paths must be unique" });
  }
  manifest.files.forEach((file, index) => {
    if (isProtectedCapturePath(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: `captured change may not write the protected path ${file.path}` });
    }
  });
  const measured = manifest.files.reduce((total, file) => total + ("sizeBytes" in file ? file.sizeBytes : 0), 0);
  if (measured !== manifest.totalBytes) {
    context.addIssue({ code: "custom", path: ["totalBytes"], message: "totalBytes must equal the sum of captured file sizes" });
  }
});
export type TaskCaptureManifestV1 = z.infer<typeof taskCaptureManifestV1Schema>;

/**
 * Canonical UTF-8 manifest text shared by capture, planning, and apply.
 *
 * Parsing first gives every participant the contract-owned shape and defaults;
 * recursively sorting object keys then makes the serialized bytes independent
 * of construction order. Keeping this here prevents an exact capture from
 * failing because two trust-boundary components serialized the same manifest
 * differently.
 */
export function taskCaptureManifestText(value: TaskCaptureManifestV1): string {
  const manifest = taskCaptureManifestV1Schema.parse(value);
  const stable = (entry: unknown): string => {
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry) ?? "null";
    if (Array.isArray(entry)) return `[${entry.map(stable).join(",")}]`;
    const record = entry as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  };
  return stable(manifest);
}

/**
 * Canonical bytes covered by `changesSha256`.
 *
 * This definition lives in the portable contract so the planning runner, the
 * trusted Worker, and the checkout-free apply job cannot drift into hashing
 * subtly different path or metadata streams. Every field is length-prefixed,
 * making concatenation injective even when a path contains control bytes that
 * the repository-path contract permits.
 */
export function taskCaptureChangesDigestInput(manifest: TaskCaptureManifestV1): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const file of manifest.files) {
    const fields = file.status === "deleted"
      ? ["delete", file.path]
      : ["upsert", file.path, file.mode, String(file.sizeBytes), file.sha256];
    for (const field of fields) {
      const bytes = encoder.encode(field);
      chunks.push(encoder.encode(`${bytes.byteLength}:`), bytes);
    }
  }
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Compact pointer to a capture, used where the full manifest is unnecessary
 * (tool results and receipts).
 */
export const taskCaptureRefV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-capture-ref/v1"),
  captureId: boundIdentifier,
  baseSha: sha1,
  /** Digest of the canonical manifest JSON. */
  manifestSha256: sha256,
  /**
   * Digest of the canonical length-prefixed change stream binding each path,
   * status, mode, size, and content digest. This is independent of archive
   * container bytes so packaging cannot change the plan-bound identity.
   */
  changesSha256: sha256,
  fileCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sizeBytes: captureByteCount,
});
export type TaskCaptureRefV1 = z.infer<typeof taskCaptureRefV1Schema>;


/* -------------------------------------------------------------------------- */
/* Event binding                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The primary resource an event carried, if any. `push` and `schedule` carry
 * none, nor does a manual run without a target, which is why the binding is
 * nullable rather than invented.
 */
export const taskEventResourceV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("issue"), id: githubNumericId, number: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("pull_request"), id: githubNumericId, number: z.number().int().positive() }),
  z.strictObject({
    kind: z.literal("discussion"),
    id: githubNumericId,
    number: z.number().int().positive(),
    nodeId: githubNodeId,
  }),
]);
export type TaskEventResourceV1 = z.infer<typeof taskEventResourceV1Schema>;

/**
 * Exactly what the triggering event was, carried into the plan so the apply job
 * can refuse a plan that does not belong to the event it was handed. The apply
 * job is checkout-free and cannot re-derive this itself.
 */
export const taskEventBindingV1Schema = z.strictObject({
  kind: z.enum(taskTriggerKindValues),
  eventName: normalizedEventNameV1Schema,
  action: z.string().min(1).max(64).nullable(),
  resource: taskEventResourceV1Schema.nullable(),
  /** Comment the event carried, when it carried one. */
  commentId: githubNumericId.nullable(),
}).superRefine((binding, context) => {
  if (eventNameByTriggerKind[binding.kind] !== binding.eventName) {
    context.addIssue({ code: "custom", path: ["eventName"], message: "eventName does not match the trigger kind" });
  }
  if ((eventActionByTriggerKind[binding.kind] ?? null) !== binding.action) {
    context.addIssue({ code: "custom", path: ["action"], message: "action does not match the trigger kind" });
  }
});
export type TaskEventBindingV1 = z.infer<typeof taskEventBindingV1Schema>;

/**
 * The structural subset of an event a binding is derived from.
 *
 * Stated as a shape rather than as `NormalizedEventV1` so the apply job can
 * derive the identical binding from the bounded wire event it re-reads from
 * `GITHUB_EVENT_PATH`. Apply is checkout-free and never sees a normalized
 * event, and a second copy of this mapping living in the runner is exactly the
 * drift that would let a plan be applied against the wrong resource.
 */
/**
 * Derives the binding from a normalized event so planning, apply, and tests all
 * produce byte-identical bindings instead of each reimplementing the mapping.
 */
export function taskEventBindingFromNormalizedEvent(event: NormalizedEventV1): TaskEventBindingV1 {
  const base = {
    kind: event.kind,
    eventName: eventNameByTriggerKind[event.kind],
    action: eventActionByTriggerKind[event.kind] ?? null,
  } as const;
  // A manual run's target is optional, so the key may be present but empty.
  const issue = "issue" in event ? event.issue : undefined;
  if (issue !== undefined) {
    return {
      ...base,
      resource: { kind: "issue", id: issue.id, number: issue.number },
      commentId: "comment" in event ? event.comment.id : null,
    };
  }
  const pullRequest = "pullRequest" in event ? event.pullRequest : undefined;
  if (pullRequest !== undefined) {
    return {
      ...base,
      resource: { kind: "pull_request", id: pullRequest.id, number: pullRequest.number },
      commentId: "comment" in event ? event.comment.id : null,
    };
  }
  if ("discussion" in event) {
    return {
      ...base,
      resource: {
        kind: "discussion",
        id: event.discussion.id,
        number: event.discussion.number,
        nodeId: event.discussion.nodeId,
      },
      commentId: "comment" in event ? event.comment.id : null,
    };
  }
  return { ...base, resource: null, commentId: null };
}

/* -------------------------------------------------------------------------- */
/* Ordered effect plan                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pointers the trusted apply job fills from the run's capture artifact.
 *
 * These are repository file bytes. They never travel through the model, the
 * planning prompt, or the Worker: the unprivileged job captures the working
 * tree it produced, and the privileged checkout-free job streams those exact
 * bytes to the Git Data API. A model that could supply `/files` could commit
 * content no capture ever proved was in the repository, which is the whole
 * reason the write boundary exists.
 */
export const captureMaterializedPointers = {
  "commit.create": ["/files"],
} as const satisfies Partial<Record<TaskEffectKindV1, readonly string[]>>;

/**
 * Pointers this kind always defers to the capture.
 *
 * Unconditional by design. An earlier shape made deferral depend on whether
 * the payload happened to omit the field, which quietly made a model-inlined
 * file set a legitimate, capture-free commit. There is no such mode: the
 * pointer is capture-owned for every `commit.create`, and supplying it is an
 * error rather than an alternative.
 *
 * Exported because the proposal schema, the plan schema, and the runtime all
 * have to agree; two copies of this rule would eventually disagree about
 * whether a step needs a capture.
 */
export function captureDeferredPointers(kind: TaskEffectKindV1): readonly string[] {
  return (captureMaterializedPointers as Record<string, readonly string[]>)[kind] ?? [];
}

/**
 * Reports any attempt to supply a capture-owned pointer.
 *
 * Both routes are closed: writing the field into the payload, and pointing a
 * step reference at it. A reference would be just as effective at smuggling a
 * value into a location only the capture may fill, and the probe deliberately
 * suppresses issues beneath referenced pointers, so it cannot catch this.
 */
function captureOwnedPointerIssues(
  kind: TaskEffectKindV1,
  payload: unknown,
  references: Readonly<Record<string, TaskStepReferenceV1>> = {},
): readonly string[] {
  const pointers = captureDeferredPointers(kind);
  if (pointers.length === 0) return [];
  const messages: string[] = [];
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const referenced = new Set(Object.keys(references).map((pointer) => decodeJsonPointer(pointer)[0]));
  for (const pointer of pointers) {
    const [head] = decodeJsonPointer(pointer);
    if (head === undefined) continue;
    if (Object.hasOwn(record, head)) {
      messages.push(
        `${pointer} is materialized from the trusted repository capture and may not be supplied by the task`,
      );
    }
    if (referenced.has(head)) {
      messages.push(`${pointer} is materialized from the trusted repository capture and may not be referenced`);
    }
  }
  return messages;
}

/** One step of an ordered plan, with the id Gardener derived for it. */
export const taskEffectPlanOperationV1Schema = z.strictObject({
  stepName: taskStepNameV1Schema,
  /** Derived from run id, step order, step name, and canonical payload. Never model-supplied. */
  operationId: boundIdentifier,
  kind: taskEffectKindV1Schema,
  payload: taskEffectPayloadV1Schema,
  references: taskStepReferencesV1Schema.default({}),
  rationale: z.string().trim().min(1).max(5_000),
});
export type TaskEffectPlanOperationV1 = z.infer<typeof taskEffectPlanOperationV1Schema>;

/**
 * Single serialized-byte ceiling shared by the effect plan and its receipt.
 *
 * This is the one technical bound on how much a run may hand across the
 * planning/apply boundary. There is deliberately no ceiling on the *number* of
 * operations: a task that legitimately needs forty labelled steps should not be
 * truncated by a count invented here, and a byte ceiling bounds the same
 * resource honestly. `@gardener/protocol` restates this value for the wire
 * artifact; the two are asserted equal by test because the protocol package has
 * no dependency on contracts.
 */
export const EFFECT_TRANSPORT_MAX_BYTES = 4 * 1_024 * 1_024;

export interface TaskStepIssueV1 {
  /** Path within the step, for example `["references", "/body"]` or `["payload"]`. */
  readonly path: readonly string[];
  readonly message: string;
}

export interface TaskStepContextV1 {
  /** Kinds of the steps that run before this one, by step name. */
  readonly earlier: ReadonlyMap<string, OperationKind>;
  /** Names of steps that run after this one, used only to explain a forward reference. */
  readonly later?: ReadonlySet<string>;
}

function referencedOutputType(
  reference: TaskStepOutputRefV1,
  stepName: string,
  context: TaskStepContextV1,
  path: readonly string[],
  issues: TaskStepIssueV1[],
): OperationOutputType | undefined {
  if (reference.step === stepName) {
    issues.push({ path, message: "a step cannot reference its own output" });
    return undefined;
  }
  const targetKind = context.earlier.get(reference.step);
  if (targetKind === undefined) {
    issues.push({
      path,
      message: context.later?.has(reference.step)
        ? `step "${reference.step}" does not run before this step`
        : `unknown step "${reference.step}"`,
    });
    return undefined;
  }
  const outputType = operationOutputType(targetKind, reference.output);
  if (outputType === undefined) {
    issues.push({
      path,
      message: `${targetKind} does not publish a scalar output named "${reference.output}"; `
        + `it publishes ${operationOutputNames(targetKind).map((name) => `"${name}"`).join(", ")}`,
    });
  }
  return outputType;
}

/**
 * Every problem with one step given the steps before it: references that name
 * an unknown, later, or self step or an unpublished output; capture-owned
 * fields; and the payload's operation shape with each reference typed by the
 * output it resolves to.
 *
 * Planning and proposal admission share this, so a proposal the Worker admits
 * is one the finished plan will accept, and a model that references a missing
 * output is told while it can still correct the step.
 */
export function taskStepIssues(
  step: Pick<TaskEffectPlanOperationV1, "stepName" | "kind" | "payload" | "references">,
  context: TaskStepContextV1,
): TaskStepIssueV1[] {
  const issues: TaskStepIssueV1[] = [];
  const resolvedTypes = new Map<string, OperationOutputType>();
  const outputKey = (output: TaskStepOutputRefV1) => `${output.step}\u0000${output.output}`;
  for (const [pointer, reference] of Object.entries(step.references)) {
    for (const { placeholder, output: reference_ } of referenceOutputs(reference)) {
      const path = placeholder === undefined ? ["references", pointer] : ["references", pointer, "placeholders", placeholder];
      const outputType = referencedOutputType(reference_, step.stepName, context, path, issues);
      if (outputType === undefined) continue;
      if (placeholder !== undefined && outputType === "nullableGithubId") {
        issues.push({ path, message: `"${reference_.output}" may be null and cannot fill a placeholder` });
        continue;
      }
      resolvedTypes.set(outputKey(reference_), outputType);
    }
    if (isTemplateReference(reference)) {
      const template = readPayloadPointer(step.payload, pointer);
      if (typeof template !== "string") {
        issues.push({ path: ["payload", ...decodeJsonPointer(pointer)], message: "a field with placeholders must be text written in the payload" });
        continue;
      }
      for (const name of Object.keys(reference.placeholders)) {
        if (!template.includes(placeholderToken(name))) {
          issues.push({ path: ["references", pointer, "placeholders", name], message: `the text at ${pointer} does not contain ${placeholderToken(name)}` });
        }
      }
    }
  }

  for (const message of captureOwnedPointerIssues(step.kind, step.payload, step.references)) {
    issues.push({ path: ["payload"], message });
  }
  for (const message of probeOperationShape({
    kind: step.kind,
    payload: step.payload,
    references: step.references,
    deferredPointers: captureDeferredPointers(step.kind),
    resolveOutputType: (reference) => resolvedTypes.get(outputKey(reference)),
  })) {
    issues.push({ path: ["payload"], message });
  }
  return issues;
}

/**
 * Exact, hashable, ordered handoff consumed by the checkout-free effects job.
 *
 * There is no Gardener-imposed ceiling on the number of operations. The bounds
 * that apply are the task's own optional `maxEffectOperations` and
 * `maxEffectBytes`, the unconditional `EFFECT_TRANSPORT_MAX_BYTES` transport
 * ceiling enforced below, and the provider's own rate limits. A plan with zero
 * operations is valid and normal: an inspect-only run produces one.
 */
export const taskEffectPlanV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-effect-plan/v1"),
  runId: boundIdentifier,
  taskId: identifier,
  taskName: z.string().trim().min(1).max(100),
  bundleHash: sha256,
  /**
   * Repository identity every operation in this plan is constructed from.
   *
   * `defaultBranch` travels in the plan rather than being read back at apply
   * time because it is part of the canonical operation hash. Re-fetching a
   * mutable value would let the same plan hash differently on a retry.
   */
  repository: z.strictObject({
    id: githubNumericId,
    fullName: repositoryFullName,
    defaultBranch: z.string().trim().min(1).max(255),
  }),
  provenance: z.strictObject({
    sourcePath: relativePath,
    commitSha: sha1,
    workflowRunId: githubNumericId,
    workflowRunAttempt: z.number().int().positive(),
  }),
  event: taskEventBindingV1Schema,
  /** Copied from the bundle so apply enforces the same ceilings planning did. */
  limits: z.strictObject({
    maxEffectOperations: z.number().int().positive().max(1_000).optional(),
    maxEffectBytes: z.number().int().min(1_024).max(50_000_000).optional(),
  }),
  /** Present only when a step materializes repository changes at apply time. */
  capture: taskCaptureManifestV1Schema.optional(),
  /** Digest of the changes artifact the capture manifest describes. */
  changesSha256: sha256.optional(),
  operations: z.array(taskEffectPlanOperationV1Schema),
}).superRefine((plan, context) => {
  const indexByStepName = new Map<string, number>();
  plan.operations.forEach((operation, index) => {
    if (indexByStepName.has(operation.stepName)) {
      context.addIssue({ code: "custom", path: ["operations", index, "stepName"], message: "step names must be unique within a plan" });
      return;
    }
    indexByStepName.set(operation.stepName, index);
  });

  const operationIds = plan.operations.map((operation) => operation.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    context.addIssue({ code: "custom", path: ["operations"], message: "operation IDs must be unique within a plan" });
  }

  let anyStepDefersToCapture = false;

  plan.operations.forEach((operation, index) => {
    const earlier = new Map(plan.operations.slice(0, index).map((candidate) => [candidate.stepName, candidate.kind] as const));
    const later = new Set(plan.operations.slice(index + 1).map((candidate) => candidate.stepName));
    for (const issue of taskStepIssues(operation, { earlier, later })) {
      context.addIssue({ code: "custom", path: ["operations", index, ...issue.path], message: issue.message });
    }
    if (captureDeferredPointers(operation.kind).length > 0) anyStepDefersToCapture = true;
  });

  const { maxEffectOperations, maxEffectBytes } = plan.limits;
  if (maxEffectOperations !== undefined && plan.operations.length > maxEffectOperations) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: `plan has ${plan.operations.length} operations but the task allows at most ${maxEffectOperations}`,
    });
  }
  const operationBytes = canonicalJsonByteLength(plan.operations);
  if (operationBytes === null) {
    context.addIssue({ code: "custom", path: ["operations"], message: "plan operations cannot be canonically serialized" });
  } else if (maxEffectBytes !== undefined && operationBytes > maxEffectBytes) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: `plan operations serialize to ${operationBytes} bytes but the task allows at most ${maxEffectBytes}`,
    });
  }

  // The transport ceiling is unconditional. A task that declares no
  // `maxEffectBytes` still cannot emit a plan the effect artifact could not
  // carry, and there is no operation-count cap standing in for it, so this is
  // the single technical bound on plan size.
  const planBytes = canonicalJsonByteLength(plan);
  if (planBytes === null) {
    context.addIssue({ code: "custom", message: "plan cannot be canonically serialized" });
  } else if (planBytes > EFFECT_TRANSPORT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `plan serializes to ${planBytes} bytes but the effect artifact carries at most ${EFFECT_TRANSPORT_MAX_BYTES}`,
    });
  }

  if ((plan.capture === undefined) !== (plan.changesSha256 === undefined)) {
    context.addIssue({ code: "custom", path: ["changesSha256"], message: "capture manifest and changes digest must be present together" });
  }
  if (anyStepDefersToCapture && plan.capture === undefined) {
    context.addIssue({ code: "custom", path: ["capture"], message: "a step materializes repository changes but the plan carries no capture manifest" });
  }
  if (!anyStepDefersToCapture && plan.capture !== undefined) {
    context.addIssue({ code: "custom", path: ["capture"], message: "the plan carries a capture manifest that no step materializes" });
  }
  if (plan.capture !== undefined && plan.capture.baseSha !== plan.provenance.commitSha) {
    context.addIssue({ code: "custom", path: ["capture", "baseSha"], message: "capture base must equal the planning commit" });
  }
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
    /**
     * Ordered steps the model proposes, in the order it wants them applied.
     * Unbounded by count for the same reason the plan is: the task's own
     * `maxEffectOperations` is the ceiling that matters, and an empty list is
     * the normal result of an inspect-only run.
     */
    proposedEffects: z.array(taskEffectProposalV1Schema),
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
