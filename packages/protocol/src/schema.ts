import { z } from "zod";

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const githubNumericId = z.string().regex(/^[1-9][0-9]{0,19}$/);

/**
 * Serialized-byte ceiling shared by the effect plan artifact and its receipt,
 * in *decoded* bytes.
 *
 * Must equal `EFFECT_TRANSPORT_MAX_BYTES` in `@gardener/contracts`. It is
 * restated rather than imported because this package deliberately has no
 * dependency on contracts; `packages/runner`, which depends on both, is where
 * the two are asserted equal.
 */
export const EFFECT_TRANSPORT_MAX_BYTES = 4 * 1_024 * 1_024;

/** Canonical byte length, or `null` when the value cannot be serialized at all. */
function canonicalJsonByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return new TextEncoder().encode(encoded).length;
  } catch {
    return null;
  }
}

/**
 * GitHub Actions event names Gardener admits over the wire. Kept in lockstep
 * with the contracts package; `pull_request_target` is excluded by design.
 */
export const runnerEventNameV1Schema = z.enum([
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
export type RunnerEventNameV1 = z.infer<typeof runnerEventNameV1Schema>;

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
  eventName: runnerEventNameV1Schema,
  ref: z.string().min(1).max(1_024),
  runnerEnvironment: z.literal("github-hosted"),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  agentHash: sha256,
});

const runnerActionBaseFields = {
  schemaVersion: z.literal("gardener.runner.action/v1"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operationId: identifier,
  timeoutMs: z.number().int().positive().max(10 * 60 * 1_000),
};

/**
 * Read-only provider request executed by the planning bridge. The repository
 * token stays in the bridge process; neither the request nor its result can
 * carry credentials back to the runtime or the model.
 */
export const githubReadRequestV1Schema = z.discriminatedUnion("transport", [
  z.strictObject({
    transport: z.literal("rest"),
    method: z.enum(["GET", "HEAD"]),
    path: z.string().min(1).max(2_048),
  }),
  z.strictObject({
    transport: z.literal("graphql"),
    query: z.string().min(1).max(32 * 1024),
    /**
     * Bounded by count and serialized size. Actions are canonicalized into
     * Durable Object storage, so an unbounded variables map would let a model
     * grow durable state without limit.
     */
    variables: z.record(z.string().min(1).max(128), z.unknown())
      .refine((value) => Object.keys(value).length <= 64, "too many GraphQL variables")
      .refine((value) => {
        const serialized = JSON.stringify(value);
        return serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= 32 * 1024;
      }, "GraphQL variables exceed the size limit")
      .optional(),
    operationName: z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,127}$/).optional(),
  }),
]);

export const runnerActionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...runnerActionBaseFields,
    kind: z.literal("shell.exec"),
    command: z.string().min(1).max(64 * 1024),
    cwd: z.string().min(1).max(4_096),
    maxOutputBytes: z.number().int().positive().max(4 * 1024 * 1024),
  }),
  z.strictObject({
    ...runnerActionBaseFields,
    kind: z.literal("github.read"),
    request: githubReadRequestV1Schema,
    maxOutputBytes: z.number().int().positive().max(1024 * 1024),
  }),
  /**
   * Trusted working-tree capture.
   *
   * Only the runtime issues this, and only once it holds a durable proposal
   * that materializes repository changes. There is deliberately no field a
   * model could fill: no paths, no directory, no content, no filters. The
   * whole tree is captured, judged by Git against a baseline the runner took
   * before the first task command ran, so what lands in a commit is what the
   * runner observed rather than what the model claimed.
   *
   * `baseSha` is the commit the runtime bound the run to. The runner refuses
   * the action unless its own pre-execution baseline was taken against the
   * same commit, so neither side can drift alone.
   */
  z.strictObject({
    ...runnerActionBaseFields,
    kind: z.literal("repository.capture"),
    baseSha: sha1,
    maxOutputBytes: z.number().int().positive().max(EFFECT_TRANSPORT_MAX_BYTES),
  }),
]);

/**
 * Plan-bound pointer to one capture. Mirrors `taskCaptureRefV1Schema` in
 * `@gardener/contracts`; restated rather than imported for the same reason as
 * every other shape here — this package has no contracts dependency.
 */
export const runnerCaptureRefV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.task-capture-ref/v1"),
  captureId: identifier,
  baseSha: sha1,
  manifestSha256: sha256,
  changesSha256: sha256,
  fileCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type RunnerCaptureRefV1 = z.infer<typeof runnerCaptureRefV1Schema>;

/**
 * Metadata-only capture envelope, carried in a capture action's `stdout`.
 *
 * Everything here is a digest, a count, or canonical manifest *text*. There is
 * no field for file bytes and no field for a runner-local path, and the object
 * is strict, so a capture crossing the Cap'n Web boundary cannot carry either
 * even by accident. The artifact directory stays in the runner process; the
 * runtime learns only what it must bind into the plan.
 *
 * The manifest travels as canonical JSON text rather than as a parsed object
 * on purpose. `manifestSha256` then fixes exactly the bytes the runtime
 * re-parses with the authoritative contracts schema, and this package does not
 * have to restate a manifest shape it cannot keep in step.
 */
export const runnerCaptureResultV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    schemaVersion: z.literal("gardener.runner.capture-result/v1"),
    /** The working tree matched the checked-out commit; there is nothing to commit. */
    status: z.literal("unchanged"),
  }),
  z.strictObject({
    schemaVersion: z.literal("gardener.runner.capture-result/v1"),
    status: z.literal("captured"),
    ref: runnerCaptureRefV1Schema,
    manifestJson: z.string().min(2).max(EFFECT_TRANSPORT_MAX_BYTES),
  }),
]);
export type RunnerCaptureResultV1 = z.infer<typeof runnerCaptureResultV1Schema>;

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

/**
 * Untrusted event payload reported by the runner. It deliberately carries no
 * repository, run, ref, commit, or actor identity: the runtime takes every one
 * of those from the verified OIDC hello, so a tampered payload cannot rebind a
 * run to another repository or actor.
 */
const eventActor = z.strictObject({
  id: githubNumericId,
  login: z.string().min(1).max(100),
});

const eventLabels = z.array(z.string().trim().min(1).max(100)).max(100);
const eventBody = z.string().max(65_536).nullable();
const eventNodeId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_=-]+$/);
const eventChangedLabel = z.string().trim().min(1).max(100);

const eventIssue = z.strictObject({
  id: githubNumericId,
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: eventBody,
  // Older immutable bridge pins omit these fields. Current bridge code emits
  // them, but the runtime accepts the old shape so deploys do not strand runs.
  state: z.enum(["open", "closed"]).optional(),
  updatedAt: z.iso.datetime().optional(),
  labels: eventLabels,
  author: eventActor,
});

const eventPullRequestRepository = z.strictObject({
  id: githubNumericId,
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(201),
});

const eventPullRequest = z.strictObject({
  id: githubNumericId,
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: eventBody,
  labels: eventLabels,
  author: eventActor,
  draft: z.boolean(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
  base: z.strictObject({ ref: z.string().min(1).max(255), sha: sha1, repo: eventPullRequestRepository }),
  head: z.strictObject({ ref: z.string().min(1).max(255), sha: sha1, repo: eventPullRequestRepository.nullable() }),
});

const eventComment = z.strictObject({ id: githubNumericId, body: eventBody, updatedAt: z.iso.datetime().optional(), author: eventActor });

const eventReview = z.strictObject({
  id: githubNumericId,
  state: z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]),
  body: eventBody,
  author: eventActor,
});

const eventDiscussion = z.strictObject({
  id: githubNumericId,
  nodeId: eventNodeId,
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  body: eventBody,
  labels: eventLabels,
  author: eventActor,
  category: z.string().min(1).max(100),
  answered: z.boolean(),
  state: z.enum(["open", "closed"]).optional(),
  updatedAt: z.iso.datetime().optional(),
});

const eventDiscussionComment = z.strictObject({
  id: githubNumericId,
  nodeId: eventNodeId,
  body: eventBody,
  updatedAt: z.iso.datetime().optional(),
  author: eventActor,
});

const eventPush = z.strictObject({
  ref: z.string().min(1).max(1_024),
  before: sha1,
  after: sha1,
  forced: z.boolean(),
  commits: z.array(z.strictObject({
    sha: sha1,
    message: z.string().max(4_096),
    author: z.strictObject({ name: z.string().max(200), email: z.string().max(320) }),
  })).max(20),
  /** Count present in `commits`; never claimed to be the push total. */
  includedCommits: z.number().int().min(0).max(20),
  commitsTruncated: z.boolean(),
});

/**
 * Repository facts that exist only in the event payload.
 *
 * Repository identity is otherwise derived from the OIDC hello and never from
 * anything the runner says, which is why this member is so narrow. The default
 * branch is the exception: it is not an OIDC claim and not part of enrollment,
 * yet every exact operation embeds it, so it has to travel with the event. It
 * is read from the payload rather than fetched at apply time because it is
 * mutable, and a later fetch could return a value that was never true for this
 * run while silently changing canonical operation identity. The apply job
 * re-reads the same payload and compares, so a runner that lied about it
 * cannot get the plan applied.
 */
const eventRepository = z.strictObject({ defaultBranch: z.string().trim().min(1).max(255) });

function runnerEventMember<Kind extends string, Shape extends z.ZodRawShape>(kind: Kind, shape: Shape) {
  return z.strictObject({
    schemaVersion: z.literal("gardener.runner.event/v1"),
    kind: z.literal(kind),
    repository: eventRepository,
    ...shape,
  });
}

const issuePayload = { issue: eventIssue };
const pullRequestPayload = { pullRequest: eventPullRequest };
const discussionPayload = { discussion: eventDiscussion };

export const runnerEventV1Schema = z.discriminatedUnion("kind", [
  runnerEventMember("github.issue.opened", issuePayload),
  runnerEventMember("github.issue.edited", issuePayload),
  runnerEventMember("github.issue.labeled", { ...issuePayload, label: eventChangedLabel }),
  runnerEventMember("github.issue.unlabeled", { ...issuePayload, label: eventChangedLabel }),
  runnerEventMember("github.issue.reopened", issuePayload),
  runnerEventMember("github.issue_comment.created", { ...issuePayload, comment: eventComment }),
  runnerEventMember("github.pull_request.opened", pullRequestPayload),
  runnerEventMember("github.pull_request.reopened", pullRequestPayload),
  runnerEventMember("github.pull_request.synchronize", pullRequestPayload),
  runnerEventMember("github.pull_request.ready_for_review", pullRequestPayload),
  runnerEventMember("github.pull_request.converted_to_draft", pullRequestPayload),
  runnerEventMember("github.pull_request.edited", pullRequestPayload),
  runnerEventMember("github.pull_request.labeled", { ...pullRequestPayload, label: eventChangedLabel }),
  runnerEventMember("github.pull_request.unlabeled", { ...pullRequestPayload, label: eventChangedLabel }),
  runnerEventMember("github.pull_request_review.submitted", { ...pullRequestPayload, review: eventReview }),
  runnerEventMember("github.pull_request_review_comment.created", { ...pullRequestPayload, comment: eventComment }),
  runnerEventMember("github.push", { push: eventPush }),
  runnerEventMember("github.workflow_dispatch", { prompt: z.string().trim().min(1).max(20_000) }),
  runnerEventMember("github.schedule", { cron: z.string().trim().min(1).max(100) }),
  runnerEventMember("github.discussion.created", discussionPayload),
  runnerEventMember("github.discussion.edited", discussionPayload),
  runnerEventMember("github.discussion.answered", discussionPayload),
  runnerEventMember("github.discussion.unanswered", discussionPayload),
  runnerEventMember("github.discussion.labeled", { ...discussionPayload, label: eventChangedLabel }),
  runnerEventMember("github.discussion.unlabeled", { ...discussionPayload, label: eventChangedLabel }),
  runnerEventMember("github.discussion_comment.created", { ...discussionPayload, comment: eventDiscussionComment }),
]);

/**
 * Step name from the ordered plan. Mirrors `taskStepNameV1Schema` in
 * `@gardener/contracts`; the protocol package deliberately has no dependency on
 * contracts, so the pattern is restated rather than imported.
 */
const stepName = z.string().regex(/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/).max(63);

/** Every URL a receipt may carry must be a real GitHub web link. */
const githubUrl = z.url().refine(
  (value) => new URL(value).origin === "https://github.com",
  "Expected an HTTPS github.com URL",
);

/**
 * Per-operation receipt, structurally mirroring `operationReceiptSchema` in
 * `@gardener/contracts`.
 *
 * `kind` is a bounded string rather than the 29-value enum for the same
 * dependency reason: duplicating the enum in two packages is exactly the drift
 * this boundary must not have. The runtime re-parses every receipt with the
 * contracts schema before it is stored, so the authoritative enum is still
 * enforced before anything is persisted.
 */
export const runnerOperationReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal("v2"),
  operationId: identifier,
  operationHash: sha256,
  kind: z.string().min(1).max(100).regex(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/),
  status: z.enum(["succeeded", "failed", "skipped", "conflicted"]),
  attempt: z.number().int().positive(),
  attemptedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  providerRequestId: z.string().min(1).max(255).optional(),
  resourceUrl: githubUrl.optional(),
  error: z.strictObject({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
  }).optional(),
}).superRefine((receipt, context) => {
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.attemptedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "operation cannot complete before it was attempted" });
  }
  if ((receipt.status === "failed" || receipt.status === "conflicted") && !receipt.error) {
    context.addIssue({ code: "custom", path: ["error"], message: "failed and conflicted receipts require an error" });
  }
  if ((receipt.status === "succeeded" || receipt.status === "skipped") && receipt.error) {
    context.addIssue({ code: "custom", path: ["error"], message: "successful receipts cannot contain an error" });
  }
});
export type RunnerOperationReceiptV1 = z.infer<typeof runnerOperationReceiptV1Schema>;

/** One applied step: the plan's step name plus the provider receipt it produced. */
const runnerScalarOutputV1Schema = z.union([
  z.string().max(65_536),
  z.number().safe(),
  z.boolean(),
  z.null(),
]);

export const runnerPlanStepReceiptV1Schema = z.strictObject({
  stepName,
  receipt: runnerOperationReceiptV1Schema,
  /** Scalar provider outputs needed to resolve references after a retry. */
  outputs: z.record(z.string().min(1).max(100), runnerScalarOutputV1Schema).default({}),
});
export type RunnerPlanStepReceiptV1 = z.infer<typeof runnerPlanStepReceiptV1Schema>;

/**
 * Receipt for one ordered plan application.
 *
 * Failure policy is stop-and-resume: the apply job halts on the first failed or
 * conflicted step and never runs a later dependent effect, so `operations` is a
 * prefix of the plan. `status` and `stoppedAtStep` make that prefix explicit
 * rather than leaving it to be inferred from a length comparison.
 */
export const runnerEffectReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.effect-receipt/v1"),
  planRunId: identifier,
  bundleHash: sha256,
  artifactSha256: sha256,
  /** Digest of the changes artifact, when the plan materialized repository changes. */
  changesSha256: sha256.optional(),
  /**
   * Number of operations the plan this receipt answers contained. Without it a
   * receipt cannot be shown to be complete: `operations.length` alone says
   * nothing about how many steps were supposed to run, so a truncated apply
   * would read as a successful one.
   */
  plannedOperations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(["running", "applied", "stopped"]),
  /** The step that halted the plan, or null when every step in the plan ran. */
  stoppedAtStep: stepName.nullable(),
  /**
   * Recorded steps, in plan order. No count ceiling here either — the bound is
   * `EFFECT_TRANSPORT_MAX_BYTES`, enforced below over the canonical receipt.
   */
  operations: z.array(runnerPlanStepReceiptV1Schema).min(1),
}).superRefine((receipt, context) => {
  const bytes = canonicalJsonByteLength(receipt);
  if (bytes === null) {
    context.addIssue({ code: "custom", message: "receipt cannot be canonically serialized" });
  } else if (bytes > EFFECT_TRANSPORT_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `receipt serializes to ${bytes} bytes but the transport carries at most ${EFFECT_TRANSPORT_MAX_BYTES}`,
    });
  }
  if (receipt.operations.length > receipt.plannedOperations) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: `receipt records ${receipt.operations.length} steps but the plan contained ${receipt.plannedOperations}`,
    });
  }
  const stepNames = receipt.operations.map((entry) => entry.stepName);
  if (new Set(stepNames).size !== stepNames.length) {
    context.addIssue({ code: "custom", path: ["operations"], message: "step names must be unique within a receipt" });
  }
  const operationIds = receipt.operations.map((entry) => entry.receipt.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    context.addIssue({ code: "custom", path: ["operations"], message: "operation IDs must be unique within a receipt" });
  }
  const halted = receipt.operations.filter((entry) => entry.receipt.status === "failed" || entry.receipt.status === "conflicted");
  if (receipt.status === "running" || receipt.status === "applied") {
    if (halted.length > 0) {
      context.addIssue({ code: "custom", path: ["status"], message: `${receipt.status} plans cannot contain a failed or conflicted step` });
    }
    if (receipt.stoppedAtStep !== null) {
      context.addIssue({ code: "custom", path: ["stoppedAtStep"], message: `${receipt.status} plans did not stop at a step` });
    }
    if (receipt.status === "applied" && receipt.operations.length !== receipt.plannedOperations) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `an applied plan must record all ${receipt.plannedOperations} planned steps, not ${receipt.operations.length}`,
      });
    }
    if (receipt.status === "running" && receipt.operations.length >= receipt.plannedOperations) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "a running receipt must be an incomplete successful prefix",
      });
    }
    return;
  }
  const last = receipt.operations.at(-1);
  if (last === undefined || halted.length !== 1 || halted[0] !== last) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "a stopped plan halts at exactly one failed or conflicted step, which must be the last recorded step",
    });
    return;
  }
  if (receipt.stoppedAtStep !== last.stepName) {
    context.addIssue({ code: "custom", path: ["stoppedAtStep"], message: "stoppedAtStep must name the halting step" });
  }
});

/** Exact base64 length for `bytes` decoded bytes, including padding. */
function base64EncodedLength(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** Decoded byte count of a syntactically valid base64 string, without decoding it. */
export function base64DecodedLength(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return (encoded.length / 4) * 3 - padding;
}

/**
 * Encoded effect plan handed from planning to apply.
 *
 * `EFFECT_TRANSPORT_MAX_BYTES` is stated in *decoded* bytes, which is the unit
 * the contracts package enforces the plan in. The string length bound below is
 * the exact base64 expansion of that same number, and the refine re-checks the
 * decoded length precisely, so "4 MiB" means the same thing on both sides of
 * the boundary instead of silently meaning 3 MiB of payload.
 *
 * File bytes never travel here — they live in the separate changes artifact
 * identified by `changesSha256` — so this bounds plan structure only.
 */
export const runnerEffectArtifactV1Schema = z.strictObject({
  schemaVersion: z.literal("gardener.runner.effect-artifact/v1"),
  sha256,
  bytesBase64: z.string()
    .min(1)
    .max(base64EncodedLength(EFFECT_TRANSPORT_MAX_BYTES))
    /**
     * Deliberately a flat character class rather than the grouped
     * `(?:[A-Za-z0-9+/]{4})*` form. V8 recurses on that quantifier and throws
     * `RangeError: Maximum call stack size exceeded` on a multi-megabyte
     * string, which the old 128 KiB cap hid; at this size that is a denial of
     * service reachable from a planning artifact. The `% 4` check below
     * restores the group alignment the grouped pattern used to provide.
     */
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine(
      (value) => value.length % 4 === 0,
      "Expected a padded base64 string",
    )
    .refine(
      (value) => base64DecodedLength(value) <= EFFECT_TRANSPORT_MAX_BYTES,
      `Expected at most ${EFFECT_TRANSPORT_MAX_BYTES} decoded bytes`,
    ),
  /**
   * Digest of the repository-changes artifact this plan materializes, when it
   * materializes one. Bound here so apply can refuse a plan/changes mismatch
   * before it writes anything.
   */
  changesSha256: sha256.optional(),
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
export type GitHubReadRequestV1 = z.infer<typeof githubReadRequestV1Schema>;
export type RunnerActionV1 = z.infer<typeof runnerActionV1Schema>;
export type RunnerShellActionV1 = Extract<RunnerActionV1, { kind: "shell.exec" }>;
export type RunnerGitHubReadActionV1 = Extract<RunnerActionV1, { kind: "github.read" }>;
export type RunnerCaptureActionV1 = Extract<RunnerActionV1, { kind: "repository.capture" }>;
export type RunnerActionResultV1 = z.infer<typeof runnerActionResultV1Schema>;
export type RunnerEventV1 = z.infer<typeof runnerEventV1Schema>;
export type RunnerEffectReceiptV1 = z.infer<typeof runnerEffectReceiptV1Schema>;
export type RunnerEffectArtifactV1 = z.infer<typeof runnerEffectArtifactV1Schema>;
export type RunnerTerminalV1 = z.infer<typeof runnerTerminalV1Schema>;
export type ResumeCursorV1 = z.infer<typeof resumeCursorV1Schema>;
