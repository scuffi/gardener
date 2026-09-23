import { z } from "zod";
import { githubNumericIdSchema } from "./identity";
import { operationRepositoryRefSchema } from "./repository";

export const operationKindValues = [
  "issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update", "issue.close", "issue.reopen", "issue.assignee.add", "issue.assignee.remove",
  "pull_request.comment.create", "pull_request.comment.update", "pull_request.review.submit", "pull_request.reviewer.request", "pull_request.reviewer.remove", "pull_request.update",
  "branch.create", "commit.create", "pull_request.open_draft", "pull_request.merge",
  "discussion.comment.create", "discussion.comment.update", "discussion.answer.mark", "discussion.answer.unmark", "discussion.close", "discussion.reopen",
  "check.rerun",
  "release.create", "release.update", "release.publish", "release.delete",
] as const;
export const operationKindSchema = z.enum(operationKindValues);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const operationFamilySchema = z.enum(["issue", "pull_request", "git", "discussion", "check", "release"]);
export const operationCatalogEntrySchema = z.object({ kind: operationKindSchema, family: operationFamilySchema, persistent: z.literal(true), highImpact: z.boolean() }).strict();
export type OperationCatalogEntry = z.infer<typeof operationCatalogEntrySchema>;
export const operationCatalog: readonly OperationCatalogEntry[] = Object.freeze(operationKindValues.map((kind) => operationCatalogEntrySchema.parse({
  kind,
  family: kind.startsWith("issue.") ? "issue" : kind.startsWith("pull_request.") ? "pull_request" : kind === "branch.create" || kind === "commit.create" ? "git" : kind.startsWith("discussion.") ? "discussion" : kind.startsWith("check.") ? "check" : "release",
  persistent: true,
  highImpact: kind === "pull_request.merge" || kind === "release.publish" || kind === "release.delete",
})));

export const shaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);
export function isValidGitBranchName(value: string): boolean {
  const components = value.split("/");
  return value !== "@" && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") &&
    !value.includes("..") && !value.includes("//") && !value.includes("@{") && !/[~^:?*[\\\x00-\x20\x7f]/.test(value) &&
    components.every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".") && !component.endsWith(".lock"));
}
export const branchNameSchema = z.string().trim().min(1).max(255).refine(isValidGitBranchName, "invalid Git branch name");
export const gardenerBranchNameSchema = branchNameSchema.refine((value) => value.startsWith("gardener/"), "branch must use the gardener/ namespace");

const operationIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,255}$/);
/**
 * Largest commit a single operation may write.
 *
 * One blob POST per added or modified path, executed sequentially, so this is
 * a bound on the work a single step can take rather than on any provider
 * limit. `taskCaptureManifestV1Schema` carries the same bound, which is what
 * makes a verified capture always materializable: an oversized change set is
 * refused when the capture is admitted — before a plan exists, and therefore
 * long before the first write — instead of failing partway through apply.
 */
export const COMMIT_FILE_LIMIT = 1_000;

/**
 * Encoded-byte budget for commit content carried *inside* the operation.
 *
 * Capture-backed content is exempt because it never enters the operation; see
 * the `commit.create` refinement.
 */
export const INLINE_COMMIT_CONTENT_MAX_ENCODED_BYTES = 7_000_000;

const canonicalBase64Schema = z.string().regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/,
  "expected canonical base64 content",
);

const commitFilePathSchema = z.string().min(1).max(1_024).refine(
  (path) => !path.startsWith("/") && !path.endsWith("/") && !path.includes("\\")
    && path.split("/").every((component) => component.length > 0 && component !== "." && component !== ".."),
  "invalid repository path",
);

/**
 * A commit file whose bytes travel inside the operation.
 *
 * `null` content deletes the path. This is the shape an installation-backed
 * boundary uses, where the planner and the writer are the same process.
 */
const inlineCommitFileSchema = z.object({
  path: commitFilePathSchema,
  contentBase64: canonicalBase64Schema.max(1_400_000).nullable(),
}).strict();

/**
 * A commit file whose bytes stay in the verified capture artifact.
 *
 * Gardener's planning job runs unprivileged with a checkout; the apply job is
 * privileged and has no checkout. Content therefore cannot travel with the
 * operation: it would have to pass through the model's reach, and the plan
 * itself is stored and forwarded in places a 100 MiB file cannot go. Instead
 * the operation carries only the metadata the capture artifact already proved
 * — path, status, mode, size, and content digest — and apply streams each
 * blob out of the artifact one at a time after verifying it.
 *
 * That metadata is exactly what canonical operation identity needs: the
 * digests pin the content as tightly as the bytes would, so the operation hash
 * (and the commit trailer derived from it) stays a function of what is written
 * without ever holding what is written.
 */
const capturedCommitFileSchema = z.object({
  path: commitFilePathSchema,
  captured: z.discriminatedUnion("status", [
    z.object({
      status: z.enum(["added", "modified"]),
      mode: z.enum(["100644", "100755", "120000"]),
      /** Bounded by GitHub's per-blob maximum, so an inapplicable capture is refused before apply. */
      sizeBytes: z.number().int().nonnegative().max(100 * 1_024 * 1_024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({ status: z.literal("deleted") }).strict(),
  ]),
}).strict();

const commitFileSchema = z.union([inlineCommitFileSchema, capturedCommitFileSchema]);

const operationBase = z.object({ schemaVersion: z.literal("v2"), id: operationIdSchema, repository: operationRepositoryRefSchema });
const expectedTimestamp = z.iso.datetime();
const body = z.string().min(1).max(65_536);
const issueBase = operationBase.extend({ issueNumber: z.number().int().positive(), expectedIssueState: z.enum(["open", "closed"]), expectedIssueUpdatedAt: expectedTimestamp });
const pullBase = operationBase.extend({
  pullNumber: z.number().int().positive(), expectedHeadSha: shaSchema, expectedBaseRef: branchNameSchema,
  expectedBaseSha: shaSchema, expectedState: z.enum(["open", "closed"]), expectedDraft: z.boolean(), expectedPullUpdatedAt: expectedTimestamp,
});
const discussionBase = operationBase.extend({ discussionNumber: z.number().int().positive(), expectedDiscussionState: z.enum(["open", "closed"]), expectedDiscussionUpdatedAt: expectedTimestamp });
const commentUpdate = { commentId: githubNumericIdSchema, expectedCommentUpdatedAt: expectedTimestamp, body } as const;
const requiredCheckSchema = z.object({ context: z.string().trim().min(1).max(255), appId: z.number().int().positive() }).strict();

const operationOptions = [
  issueBase.extend({ kind: z.literal("issue.label.add"), label: z.string().trim().min(1).max(100) }).strict(),
  issueBase.extend({ kind: z.literal("issue.label.remove"), label: z.string().trim().min(1).max(100) }).strict(),
  issueBase.extend({ kind: z.literal("issue.comment.create"), body }).strict(),
  issueBase.extend({ kind: z.literal("issue.comment.update"), ...commentUpdate }).strict(),
  issueBase.extend({ kind: z.literal("issue.close"), expectedIssueState: z.literal("open") }).strict(),
  issueBase.extend({ kind: z.literal("issue.reopen"), expectedIssueState: z.literal("closed") }).strict(),
  issueBase.extend({ kind: z.literal("issue.assignee.add"), assigneeId: githubNumericIdSchema }).strict(),
  issueBase.extend({ kind: z.literal("issue.assignee.remove"), assigneeId: githubNumericIdSchema }).strict(),

  pullBase.extend({ kind: z.literal("pull_request.comment.create"), body }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.comment.update"), ...commentUpdate }).strict(),
  pullBase.extend({
    kind: z.literal("pull_request.review.submit"), expectedState: z.literal("open"), event: z.enum(["comment", "approve", "request_changes"]),
    body: z.string().max(65_536), comments: z.array(z.object({ path: z.string().min(1).max(1_024), line: z.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]), body }).strict()).max(100),
  }).strict().superRefine((value, context) => {
    if (value.event !== "approve" && !value.body.trim() && value.comments.length === 0) context.addIssue({ code: "custom", path: ["body"], message: "comment and request-changes reviews require content" });
  }),
  pullBase.extend({ kind: z.literal("pull_request.reviewer.request"), reviewerIds: z.array(githubNumericIdSchema).min(1).max(15) }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.reviewer.remove"), reviewerIds: z.array(githubNumericIdSchema).min(1).max(15) }).strict(),
  pullBase.extend({ kind: z.literal("pull_request.update"), title: z.string().trim().min(1).max(256).optional(), body: z.string().max(65_536).optional(), draft: z.boolean().optional(), state: z.enum(["open", "closed"]).optional() }).strict().superRefine((value, context) => {
    if (value.title === undefined && value.body === undefined && value.draft === undefined && value.state === undefined) context.addIssue({ code: "custom", message: "pull request update requires at least one change" });
    if (value.draft !== undefined && (value.title !== undefined || value.body !== undefined || value.state !== undefined)) {
      context.addIssue({ code: "custom", message: "draft state must be updated in a separate exact operation" });
    }
  }),
  operationBase.extend({ kind: z.literal("branch.create"), branch: gardenerBranchNameSchema, fromSha: shaSchema, expectedAbsent: z.literal(true) }).strict(),
  operationBase.extend({
    kind: z.literal("commit.create"), branch: gardenerBranchNameSchema, expectedHeadSha: shaSchema, message: z.string().trim().min(1).max(1_000),
    files: z.array(commitFileSchema).min(1).max(COMMIT_FILE_LIMIT),
  }).strict().superRefine((value, context) => {
    const paths = new Set<string>(); let encodedBytes = 0; let inlineFiles = 0;
    value.files.forEach((file, index) => {
      if (paths.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "commit file paths must be unique" });
      paths.add(file.path);
      if ("contentBase64" in file) { inlineFiles += 1; encodedBytes += file.contentBase64?.length ?? 0; }
    });
    // The inline budget is unchanged and still applies to inline entries. It
    // exists because those bytes travel inside the operation itself, through
    // every boundary that stores or forwards the operation. Capture-backed
    // entries carry no bytes at all, so the budget has nothing to bound; their
    // limit is the provider's per-blob maximum, already enforced by
    // `sizeBytes`.
    if (encodedBytes > INLINE_COMMIT_CONTENT_MAX_ENCODED_BYTES) context.addIssue({ code: "custom", path: ["files"], message: "encoded commit content exceeds the 5 MiB budget" });
    // A commit is either the caller's own bytes or a verified capture, never a
    // blend. Mixing them would let a plan smuggle model-authored content into
    // a commit whose provenance reads as "materialized from the capture".
    if (inlineFiles > 0 && inlineFiles !== value.files.length) {
      context.addIssue({ code: "custom", path: ["files"], message: "a commit may not mix inline content with capture-backed content" });
    }
  }),
  operationBase.extend({
    kind: z.literal("pull_request.open_draft"), head: gardenerBranchNameSchema, base: branchNameSchema, expectedHeadSha: shaSchema, expectedBaseSha: shaSchema,
    title: z.string().trim().min(1).max(256), body: z.string().max(65_536), draft: z.literal(true),
  }).strict(),
  pullBase.extend({
    kind: z.literal("pull_request.merge"), expectedState: z.literal("open"), expectedDraft: z.literal(false), method: z.enum(["merge", "squash", "rebase"]),
    /**
     * The real gate. Merging with zero verified checks is not something this
     * contract can express, in any target.
     */
    requiredChecks: z.array(requiredCheckSchema).min(1).max(100),
    /**
     * Digest of the branch-protection configuration observed when the merge was
     * proposed. Optional because the Actions target cannot read branch
     * protection with a repository `GITHUB_TOKEN` and must not fabricate a
     * digest it never computed; GitHub itself remains the authoritative
     * enforcement point there. Installation-backed boundaries that *can* read
     * protection still require it — see `evaluateOperationPolicy`, which denies
     * a merge whose expected digest is absent.
     */
    expectedBranchProtectionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),

  discussionBase.extend({ kind: z.literal("discussion.comment.create"), body }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.comment.update"), ...commentUpdate }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.answer.mark"), answerCommentId: githubNumericIdSchema, expectedAnswerCommentId: githubNumericIdSchema.nullable() }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.answer.unmark"), expectedAnswerCommentId: githubNumericIdSchema }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.close"), expectedDiscussionState: z.literal("open") }).strict(),
  discussionBase.extend({ kind: z.literal("discussion.reopen"), expectedDiscussionState: z.literal("closed") }).strict(),

  operationBase.extend({ kind: z.literal("check.rerun"), checkRunId: githubNumericIdSchema, expectedHeadSha: shaSchema, expectedStatus: z.literal("completed"), expectedConclusion: z.string().trim().min(1).max(100).nullable() }).strict(),

  operationBase.extend({
    kind: z.literal("release.create"), tagName: z.string().trim().min(1).max(255), targetCommitSha: shaSchema, expectedTagAbsent: z.literal(true),
    name: z.string().trim().min(1).max(255), body: z.string().max(65_536), draft: z.literal(true), prerelease: z.boolean(),
  }).strict(),
  operationBase.extend({
    kind: z.literal("release.update"), releaseId: githubNumericIdSchema, expectedTagName: z.string().min(1).max(255), expectedTargetCommitSha: shaSchema, expectedDraft: z.boolean(), expectedPrerelease: z.boolean(), expectedReleaseUpdatedAt: expectedTimestamp,
    name: z.string().trim().min(1).max(255).optional(), body: z.string().max(65_536).optional(), prerelease: z.boolean().optional(),
  }).strict().superRefine((value, context) => { if (value.name === undefined && value.body === undefined && value.prerelease === undefined) context.addIssue({ code: "custom", message: "release update requires at least one change" }); }),
  operationBase.extend({ kind: z.literal("release.publish"), releaseId: githubNumericIdSchema, expectedTagName: z.string().min(1).max(255), expectedTargetCommitSha: shaSchema, expectedDraft: z.literal(true), expectedPrerelease: z.boolean(), expectedPublished: z.literal(false), expectedReleaseUpdatedAt: expectedTimestamp }).strict(),
  operationBase.extend({ kind: z.literal("release.delete"), releaseId: githubNumericIdSchema, expectedTagName: z.string().min(1).max(255), expectedTargetCommitSha: shaSchema, expectedDraft: z.boolean(), expectedPublished: z.boolean(), expectedReleaseUpdatedAt: expectedTimestamp }).strict(),
] as const;

const reservedMarker = /(?:<!--\s*gardener-operation:|gardener-operation:|gardener-idempotency:)/i;
function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
}

export const operationSchema = z.discriminatedUnion("kind", operationOptions).superRefine((operation, context) => {
  const strings: string[] = [];
  if (
    operation.kind === "issue.comment.create" ||
    operation.kind === "pull_request.review.submit" ||
    operation.kind === "pull_request.open_draft"
  ) {
    const marker = `<!-- gardener-operation:${operation.id} -->`;
    const bodyWithoutExactMarker = operation.body === marker
      ? ""
      : operation.body.endsWith(`\n${marker}`)
        ? operation.body.slice(0, -(marker.length + 1))
        : operation.body;
    collectStrings({ ...operation, body: bodyWithoutExactMarker }, strings);
  } else {
    collectStrings(operation, strings);
  }
  if (strings.some((value) => reservedMarker.test(value))) context.addIssue({ code: "custom", message: "operation contains a reserved idempotency marker" });
  if ((operation.kind === "pull_request.reviewer.request" || operation.kind === "pull_request.reviewer.remove") && new Set(operation.reviewerIds).size !== operation.reviewerIds.length) context.addIssue({ code: "custom", path: ["reviewerIds"], message: "reviewer IDs must be unique" });
  if (operation.kind === "pull_request.merge") {
    const checks = operation.requiredChecks.map((check) => `${check.appId}:${check.context}`);
    if (new Set(checks).size !== checks.length) context.addIssue({ code: "custom", path: ["requiredChecks"], message: "required checks must be unique" });
  }
});
export type Operation = z.infer<typeof operationSchema>;

/**
 * Compact JSON Schema for the model-authored payload of one exact operation.
 *
 * The provider tool remains flat (`kind` plus a JSON string), avoiding the
 * 29-arm `oneOf` that Workers AI models fail to call reliably. The trusted
 * prompt can still state the exact field names and types for only the kinds a
 * task declared. Plan-owned identity/repository fields are removed, as are
 * capture-owned commit files.
 */
export function operationProposalPayloadJsonSchema(kind: OperationKind): string {
  const full = z.toJSONSchema(operationSchema, { unrepresentable: "any" }) as Record<string, unknown>;
  const options = full.oneOf;
  if (!Array.isArray(options)) throw new Error("Operation schema did not produce exact variants");
  const option = options.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const properties = (candidate as Record<string, unknown>).properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
    const discriminator = (properties as Record<string, unknown>).kind;
    return discriminator !== null && typeof discriminator === "object"
      && !Array.isArray(discriminator) && (discriminator as Record<string, unknown>).const === kind;
  });
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    throw new Error(`Operation schema has no variant for ${kind}`);
  }
  const source = structuredClone(option) as Record<string, unknown>;
  const properties = source.properties as Record<string, unknown>;
  for (const field of ["schemaVersion", "id", "repository", "kind", ...(kind === "commit.create" ? ["files"] : [])]) {
    delete properties[field];
  }
  const omitted = new Set(["schemaVersion", "id", "repository", "kind", ...(kind === "commit.create" ? ["files"] : [])]);
  source.required = Array.isArray(source.required)
    ? source.required.filter((field): field is string => typeof field === "string" && !omitted.has(field))
    : [];
  const retain = new Set(["type", "const", "enum", "format", "properties", "required", "items", "oneOf", "anyOf", "additionalProperties"]);
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(compact);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (!retain.has(key)) continue;
      // `properties` is a field-name map, not a schema object. Preserve its
      // arbitrary keys and compact each field schema below them; filtering the
      // map itself against `retain` would erase every payload field.
      output[key] = key === "properties" && entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([field, schema]) => [field, compact(schema)]))
        : compact(entry);
    }
    return output;
  };
  return JSON.stringify(compact(source));
}

export const operationReceiptSchema = z.object({
  schemaVersion: z.literal("v2"), operationId: operationIdSchema, operationHash: z.string().regex(/^[a-f0-9]{64}$/), kind: operationKindSchema,
  status: z.enum(["succeeded", "failed", "skipped", "conflicted"]), attempt: z.number().int().positive(), attemptedAt: z.iso.datetime(), completedAt: z.iso.datetime(),
  providerRequestId: z.string().min(1).max(255).optional(), resourceUrl: z.url().optional(),
  error: z.object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000), retryable: z.boolean() }).strict().optional(),
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.attemptedAt)) context.addIssue({ code: "custom", path: ["completedAt"], message: "operation cannot complete before it was attempted" });
  if ((receipt.status === "failed" || receipt.status === "conflicted") && !receipt.error) context.addIssue({ code: "custom", path: ["error"], message: "failed and conflicted receipts require an error" });
  if ((receipt.status === "succeeded" || receipt.status === "skipped") && receipt.error) context.addIssue({ code: "custom", path: ["error"], message: "successful receipts cannot contain an error" });
});
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;

/* -------------------------------------------------------------------------- */
/* Scalar operation outputs                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Value shapes a later step may consume. The type drives the typed sentinel
 * used to probe-validate a payload before the real value exists, so it has to
 * describe the value precisely enough to satisfy the consuming validator.
 */
export const operationOutputTypeValues = [
  "string",
  "resourceNumber",
  "boolean",
  "commitSha",
  "githubId",
  "nullableGithubId",
  "gardenerBranch",
  "gitRef",
  "url",
  "nodeId",
  "openClosedState",
] as const;
export type OperationOutputType = typeof operationOutputTypeValues[number];

const issueOutputs = { issueNumber: "resourceNumber" } as const;
const pullOutputs = { pullNumber: "resourceNumber" } as const;
const discussionOutputs = { discussionNumber: "resourceNumber" } as const;
const commentOutputs = { commentId: "githubId", commentUrl: "url" } as const;
const releaseOutputs = {
  releaseId: "githubId",
  tagName: "string",
  releaseUrl: "url",
  draft: "boolean",
  prerelease: "boolean",
} as const;

/**
 * Scalar outputs each operation kind publishes for later steps to reference.
 *
 * Deliberately scalar-only. The executor also returns collections such as the
 * resulting label or reviewer sets, but a plan cannot splice a list into a
 * typed operation field, so exposing them would create references that can
 * never validate. `kind` is excluded too: it is the discriminator, not a
 * produced value.
 */
export const operationOutputCatalog = {
  "issue.label.add": { ...issueOutputs, label: "string" },
  "issue.label.remove": { ...issueOutputs, label: "string" },
  "issue.comment.create": { ...issueOutputs, ...commentOutputs },
  "issue.comment.update": { ...issueOutputs, ...commentOutputs },
  "issue.close": { ...issueOutputs, state: "openClosedState", issueUrl: "url" },
  "issue.reopen": { ...issueOutputs, state: "openClosedState", issueUrl: "url" },
  "issue.assignee.add": { ...issueOutputs, assigneeId: "githubId", assigneeLogin: "string" },
  "issue.assignee.remove": { ...issueOutputs, assigneeId: "githubId", assigneeLogin: "string" },
  "pull_request.comment.create": { ...pullOutputs, ...commentOutputs },
  "pull_request.comment.update": { ...pullOutputs, ...commentOutputs },
  "pull_request.review.submit": { ...pullOutputs, reviewId: "githubId", reviewUrl: "url", reviewState: "string" },
  "pull_request.reviewer.request": { ...pullOutputs },
  "pull_request.reviewer.remove": { ...pullOutputs },
  "pull_request.update": { ...pullOutputs, pullUrl: "url", title: "string", state: "openClosedState", draft: "boolean" },
  "branch.create": { branch: "gardenerBranch", ref: "gitRef", commitSha: "commitSha", branchUrl: "url" },
  "commit.create": {
    branch: "gardenerBranch",
    commitSha: "commitSha",
    treeSha: "commitSha",
    parentSha: "commitSha",
    commitUrl: "url",
  },
  "pull_request.open_draft": {
    ...pullOutputs,
    pullUrl: "url",
    pullNodeId: "nodeId",
    headRef: "gardenerBranch",
    headSha: "commitSha",
    baseRef: "string",
  },
  "pull_request.merge": { ...pullOutputs, mergeCommitSha: "commitSha", pullUrl: "url" },
  "discussion.comment.create": { ...discussionOutputs, ...commentOutputs, commentNodeId: "nodeId" },
  "discussion.comment.update": { ...discussionOutputs, ...commentOutputs, commentNodeId: "nodeId" },
  "discussion.answer.mark": { ...discussionOutputs, answerCommentId: "nullableGithubId" },
  "discussion.answer.unmark": { ...discussionOutputs, answerCommentId: "nullableGithubId" },
  "discussion.close": { ...discussionOutputs, state: "openClosedState", discussionUrl: "url" },
  "discussion.reopen": { ...discussionOutputs, state: "openClosedState", discussionUrl: "url" },
  "check.rerun": { checkRunId: "githubId", headSha: "commitSha", status: "string" },
  "release.create": { ...releaseOutputs },
  "release.update": { ...releaseOutputs },
  "release.publish": { ...releaseOutputs },
  "release.delete": { releaseId: "githubId", tagName: "string" },
} as const satisfies Record<OperationKind, Readonly<Record<string, OperationOutputType>>>;

export type OperationOutputCatalog = typeof operationOutputCatalog;

/** Name of a scalar output a given kind publishes, or `undefined` if it has none such. */
export function operationOutputType(kind: OperationKind, output: string): OperationOutputType | undefined {
  const outputs: Readonly<Record<string, OperationOutputType>> = operationOutputCatalog[kind];
  return Object.hasOwn(outputs, output) ? outputs[output] : undefined;
}

/** Sorted scalar output names a kind publishes. */
export function operationOutputNames(kind: OperationKind): readonly string[] {
  return Object.keys(operationOutputCatalog[kind]).sort();
}

const outputSentinels = {
  string: "gardener-step-output",
  resourceNumber: 1,
  boolean: true,
  commitSha: "0".repeat(40),
  githubId: "1",
  nullableGithubId: "1",
  gardenerBranch: "gardener/step-output",
  gitRef: "refs/heads/gardener/step-output",
  url: "https://github.com/gardener/step-output",
  nodeId: "GardenerStepOutput",
  openClosedState: "open",
} as const satisfies Record<OperationOutputType, string | number | boolean>;

/**
 * Stand-in value used while probe-validating a payload whose real value is only
 * produced at apply time. A sentinel is a best-effort convenience: probe
 * validation additionally discards issues reported at a referenced pointer, so
 * correctness never depends on a sentinel satisfying every possible validator.
 */
export function operationOutputSentinel(type: OperationOutputType): string | number | boolean {
  return outputSentinels[type];
}
