import { createHash } from "node:crypto";
import {
  isProtectedCapturePath,
  isValidGitBranchName,
  operationReceiptSchema,
  operationSchema,
  type Operation,
  type OperationReceipt,
} from "@gardener/contracts";

/**
 * Checkout-free executor for every canonical `Operation` kind.
 *
 * This module runs inside the privileged, checkout-free GitHub Actions effects
 * job. It never spawns a shell, never touches a working tree, and never reads
 * repository content from disk. Every mutation is an authenticated GitHub REST
 * or GraphQL call bound to the enrolled repository.
 *
 * Authority model:
 *
 * - the caller supplies `GITHUB_TOKEN`, which acts as `github-actions[bot]`,
 *   so authorship checks match the Actions bot login (or the `github-actions`
 *   app slug);
 * - commit idempotency markers are derived from the canonical operation hash,
 *   because the effects job holds no Gardener signing key. The hash is deterministic, collision-resistant,
 *   and verifiable by any party holding the operation, which is exactly what
 *   idempotent reconciliation requires. It is not an authenticity claim; the
 *   `gardener/` branch namespace and repository binding provide that.
 */

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_ACTOR_LOGIN = "github-actions[bot]";
const DEFAULT_ACTOR_APP_SLUG = "github-actions";
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Cumulative wall-clock budget for one operation. A per-request timeout alone
 * cannot bound an operation that legitimately issues many requests (a 100-page
 * idempotency scan at 10s each would run for over sixteen minutes), so the
 * whole attempt is bounded too.
 */
const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_MAX_PAGES = 100;
const USER_AGENT = "gardener-actions-effects/1";
const COMMIT_MARKER_PREFIX = "Gardener-Operation:";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const GIT_SHA = /^[a-fA-F0-9]{40}$/;
const REPOSITORY_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
type JsonRecord = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Structured, typed outputs produced by a successful or already-applied
 * operation. Later named plan steps reference these fields by name, so every
 * value here is a stable scalar or array of scalars.
 */
export type OperationOutputsV1 =
  | { kind: "issue.label.add" | "issue.label.remove"; issueNumber: number; label: string; labels: string[] }
  | { kind: "issue.comment.create" | "issue.comment.update"; issueNumber: number; commentId: string; commentUrl: string }
  | { kind: "issue.close" | "issue.reopen"; issueNumber: number; state: "open" | "closed"; issueUrl: string }
  | {
    kind: "issue.assignee.add" | "issue.assignee.remove";
    issueNumber: number;
    assigneeId: string;
    assigneeLogin: string;
    assigneeIds: string[];
  }
  | { kind: "pull_request.comment.create" | "pull_request.comment.update"; pullNumber: number; commentId: string; commentUrl: string }
  | { kind: "pull_request.review.submit"; pullNumber: number; reviewId: string; reviewUrl: string; reviewState: string }
  | {
    kind: "pull_request.reviewer.request" | "pull_request.reviewer.remove";
    pullNumber: number;
    reviewerIds: string[];
    reviewerLogins: string[];
  }
  | { kind: "pull_request.update"; pullNumber: number; pullUrl: string; title: string; state: string; draft: boolean }
  | { kind: "branch.create"; branch: string; ref: string; commitSha: string; branchUrl: string }
  | { kind: "commit.create"; branch: string; commitSha: string; treeSha: string; parentSha: string; commitUrl: string }
  | {
    kind: "pull_request.open_draft";
    pullNumber: number;
    pullUrl: string;
    pullNodeId: string;
    headRef: string;
    headSha: string;
    baseRef: string;
  }
  | { kind: "pull_request.merge"; pullNumber: number; mergeCommitSha: string; pullUrl: string }
  | {
    kind: "discussion.comment.create" | "discussion.comment.update";
    discussionNumber: number;
    commentId: string;
    commentNodeId: string;
    commentUrl: string;
  }
  | { kind: "discussion.answer.mark" | "discussion.answer.unmark"; discussionNumber: number; answerCommentId: string | null }
  | { kind: "discussion.close" | "discussion.reopen"; discussionNumber: number; state: "open" | "closed"; discussionUrl: string }
  | { kind: "check.rerun"; checkRunId: string; headSha: string; status: string }
  | {
    kind: "release.create" | "release.update" | "release.publish";
    releaseId: string;
    tagName: string;
    releaseUrl: string;
    draft: boolean;
    prerelease: boolean;
  }
  | { kind: "release.delete"; releaseId: string; tagName: string };

export interface GitHubEffectsContext {
  /** Repository-scoped `GITHUB_TOKEN` for the privileged effects job. */
  token: string;
  /** `owner/name` binding, normally `GITHUB_REPOSITORY`. */
  repositoryFullName: string;
  /**
   * Optional caller-computed operation hash. The executor always derives the
   * hash itself; when this is supplied it must match exactly, so a caller that
   * drifts from the canonical form fails loudly instead of writing a commit
   * trailer or receipt that no later attempt can reconcile against.
   */
  operationHash?: string;
  /** 1-based attempt counter recorded on the receipt. */
  attempt: number;
  /** Authenticated writer identity. Defaults to `github-actions[bot]`. */
  actorLogin?: string;
  /** App slug backing the writer identity. Defaults to `github-actions`. */
  actorAppSlug?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  apiBaseUrl?: string;
  /** Per-request timeout. Defaults to 10s. */
  timeoutMs?: number;
  /** Cumulative budget for the whole operation. Defaults to 120s. */
  budgetMs?: number;
  maxPages?: number;
  /**
   * Reads one captured file's bytes, for a `commit.create` whose files are
   * capture-backed.
   *
   * Injected rather than read directly so this module keeps its single
   * property: it holds no repository content and touches no working tree. The
   * caller owns the verified capture artifact and hands over one file at a
   * time, which is what keeps memory bounded by the largest single file rather
   * than by the whole change set.
   *
   * The reader must return exactly the bytes whose digest and size the
   * operation records; this executor re-checks both before uploading, so a
   * reader that returned anything else fails the operation instead of writing
   * unverified content.
   */
  readCapturedFile?: (file: { path: string; sha256: string; sizeBytes: number }) => Promise<Uint8Array>;
  /**
   * `updated_at` of this operation's issue, pull request, or discussion as read
   * back immediately after an earlier step of the same plan wrote to it.
   *
   * Every step carries the planning-time `updated_at`, so without this the
   * plan's own first write would make every later step on the same resource
   * conflict. The precondition accepts either the planned value or this one,
   * and nothing else: a change by anyone other than this plan still conflicts.
   * The only change attributed to the plan that it did not make is one landing
   * between its write and the read-back that follows it.
   */
  chainedResourceVersion?: string;
  /**
   * Whether to read the resource back after a verified write. Set by the caller
   * when a later step of the plan may target the same resource; otherwise the
   * read-back would only spend requests and time budget.
   */
  readBackVersion?: boolean;
}

/** A resource's version as read back after a step of the plan wrote to it. */
export interface ResourceVersion {
  resource: string;
  updatedAt: string;
}

export interface GitHubEffectResult {
  receipt: OperationReceipt;
  /** Present when the receipt status is `succeeded` or `skipped`. */
  outputs?: OperationOutputsV1;
  /** Present after a successful step on an issue, pull request, or discussion. */
  resourceVersion?: ResourceVersion;
}

export type GitHubEffectClassification = "conflicted" | "failed";

export class GitHubEffectError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly classification: GitHubEffectClassification,
    readonly retryable = false,
    readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = "GitHubEffectError";
  }
}

/** A precondition no longer holds. Retrying the same exact operation cannot succeed. */
function conflict(code: string, message: string, providerRequestId?: string): GitHubEffectError {
  return new GitHubEffectError(code, message, "conflicted", false, providerRequestId);
}

function failure(code: string, message: string, retryable = false, providerRequestId?: string): GitHubEffectError {
  return new GitHubEffectError(code, message, "failed", retryable, providerRequestId);
}

/* -------------------------------------------------------------------------- */
/* Canonical hashing                                                           */
/* -------------------------------------------------------------------------- */

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as JsonRecord)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/** Deterministic operation identity used for receipts and commit markers. */
export function canonicalOperationHash(operation: Operation): string {
  return createHash("sha256").update(canonicalJson(operation), "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Small value helpers                                                         */
/* -------------------------------------------------------------------------- */

function isMutatingMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameInstant(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !ISO_INSTANT.test(left) || !ISO_INSTANT.test(right)) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

/** True when the resource is at its planned version or at the version this plan's own last write left. */
function atExpectedVersion(scope: ExecutionScope, actual: unknown, planned: string): boolean {
  const matches = sameInstant(actual, planned)
    || (scope.chainedResourceVersion !== undefined && sameInstant(actual, scope.chainedResourceVersion));
  if (matches) scope.versionVerified = true;
  return matches;
}

function operationMarker(id: string): string {
  return `<!-- gardener-operation:${id} -->`;
}

function hasExactOperationMarker(body: string, id: string): boolean {
  const marker = operationMarker(id);
  return body === marker || body.endsWith(`\n${marker}`);
}

function commitMarker(operationId: string, operationHash: string): string {
  return `${COMMIT_MARKER_PREFIX} ${operationId}:${operationHash}`;
}

/**
 * Encodes one URL path segment, refusing any value that would change the shape
 * of the request path rather than fill a slot in it.
 *
 * `encodeURIComponent` leaves `.` and `..` untouched, and RFC 3986 dot-segment
 * removal happens before the request is sent. An unguarded segment therefore
 * lets a caller climb the path: `DELETE /issues/5/labels/..` collapses to
 * `DELETE /issues/5`, and `DELETE /issues/5/labels/.` collapses to
 * `DELETE /issues/5/labels`, which clears every label on the issue. Contract
 * validation does not stop this — `.` and `..` are legal 1-to-100 character
 * label names and legal tag names — so the guard belongs here at the point of
 * URL construction.
 */
function encodeSegment(value: string, label: string): string {
  if (value === "" || value === "." || value === "..") {
    throw failure("unsafe_path_segment", `${label} cannot be "${value}": it would rewrite the GitHub request path`);
  }
  return encodeURIComponent(value);
}

/**
 * Encodes a Git ref or branch path for use in a REST path.
 *
 * GitHub addresses refs as multi-segment paths (`heads/gardener/fix-1`), so the
 * `/` separators must survive encoding while every other reserved character —
 * notably `#`, `%`, `+`, and `&`, all of which are legal in Git ref names — is
 * percent-encoded. `encodeURIComponent` alone would turn `/` into `%2F`, which
 * GitHub resolves as a single-segment ref and reports as 404.
 */
function encodeRefPath(value: string): string {
  return value.split("/").map((segment) => encodeSegment(segment, "Git ref segment")).join("/");
}

function isSafeFilePath(value: string): boolean {
  const lower = value.toLowerCase();
  return lower !== ".git"
    && !lower.startsWith(".git/")
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function htmlUrl(value: JsonRecord, field = "html_url"): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.startsWith("https://")) {
    throw failure("github_response_invalid", "GitHub response omitted a usable resource URL");
  }
  return candidate;
}

function numericId(value: unknown, label: string): string {
  if (!positiveInteger(value)) throw failure("github_response_invalid", `GitHub response omitted a numeric ${label}`);
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* HTTP + GraphQL client                                                       */
/* -------------------------------------------------------------------------- */

interface RestResponse {
  status: number;
  data: unknown;
  requestId?: string;
}

class GitHubApi {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxPages: number;
  readonly #clock: () => Date;
  readonly #deadline: number;
  #lastRequestId: string | undefined;
  #mutated = false;

  constructor(context: GitHubEffectsContext, deadline: number) {
    this.#token = context.token;
    this.#fetch = context.fetch ?? globalThis.fetch;
    this.#baseUrl = (context.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxPages = context.maxPages ?? DEFAULT_MAX_PAGES;
    this.#clock = context.now ?? (() => new Date());
    this.#deadline = deadline;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get lastRequestId(): string | undefined {
    return this.#lastRequestId;
  }

  /** True once any non-idempotent request has been issued during this attempt. */
  get mutated(): boolean {
    return this.#mutated;
  }

  /**
   * Issues a request and classifies it.
   *
   * Every request funnels through here so no caller can bypass mutation
   * tracking: a state-changing request that went unrecorded would be reported
   * as `skipped` rather than `succeeded`. Only GraphQL needs to override the
   * method-based classification, because a GraphQL mutation and a GraphQL query
   * are both HTTP POSTs.
   */
  async raw(
    path: string,
    init: RequestInit = {},
    mutating: boolean = isMutatingMethod(init.method),
  ): Promise<{ response: Response; requestId?: string }> {
    if (mutating) this.#mutated = true;
    const remaining = this.#deadline - this.#clock().getTime();
    if (remaining <= 0) {
      throw failure(
        "operation_budget_exhausted",
        "Operation exceeded its cumulative GitHub request budget before completing",
        true,
      );
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(Math.min(this.#timeoutMs, remaining)),
    });
    const header = response.headers?.get?.("x-github-request-id") ?? undefined;
    this.#lastRequestId = header ? header.slice(0, 255) : undefined;
    return this.#lastRequestId === undefined ? { response } : { response, requestId: this.#lastRequestId };
  }

  /** Performs a request and throws a classified error for any non-2xx status. */
  async rest(path: string, label: string, init: RequestInit = {}): Promise<RestResponse> {
    const { response, requestId } = await this.raw(path, init);
    if (!response.ok) throw await httpError(response, label, requestId);
    if (response.status === 204) {
      await response.body?.cancel();
      return { status: response.status, data: null, ...(requestId === undefined ? {} : { requestId }) };
    }
    return { status: response.status, data: await response.json(), ...(requestId === undefined ? {} : { requestId }) };
  }

  /** Performs a request, returning `null` for 404 instead of throwing. */
  async restOptional(path: string, label: string, init: RequestInit = {}): Promise<RestResponse | null> {
    const { response, requestId } = await this.raw(path, init);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw await httpError(response, label, requestId);
    if (response.status === 204) {
      await response.body?.cancel();
      return { status: response.status, data: null, ...(requestId === undefined ? {} : { requestId }) };
    }
    return { status: response.status, data: await response.json(), ...(requestId === undefined ? {} : { requestId }) };
  }

  /**
   * Scans a paginated collection for an exact match. Pagination follows the
   * `link` rel="next" marker and falls back to a short-page check, with a hard
   * page ceiling so a hostile or enormous collection cannot hang the job.
   */
  async findPaginated(
    path: string,
    label: string,
    matches: (value: JsonRecord) => boolean,
    /**
     * Envelope key for endpoints that wrap their collection. Most GitHub list
     * endpoints return a bare array, but a few (notably `check-runs`) return
     * `{ total_count, <key>: [...] }`.
     */
    envelopeKey?: string,
  ): Promise<JsonRecord | null> {
    for (let page = 1; page <= this.#maxPages; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const { response, requestId } = await this.raw(`${path}${separator}per_page=100&page=${page}`);
      if (!response.ok) throw await httpError(response, label, requestId);
      const payload = await response.json();
      const data = envelopeKey === undefined
        ? payload
        : (record(payload) ? payload[envelopeKey] : undefined);
      if (!Array.isArray(data)) throw failure("github_response_invalid", `${label} response was not a collection`);
      const match = data.filter(record).find(matches);
      if (match) return match;
      const link = response.headers?.get?.("link") ?? "";
      const hasNext = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/.test(link);
      if (!hasNext && data.length < 100) return null;
      if (!hasNext && data.length === 100 && link !== "") return null;
    }
    throw failure("github_pagination_exhausted", `${label} exceeded the ${this.#maxPages}-page idempotency scan`);
  }

  async graphql(query: string, variables: Record<string, unknown>, label: string): Promise<JsonRecord> {
    const { response, requestId } = await this.raw(
      "/graphql",
      { method: "POST", body: JSON.stringify({ query, variables }) },
      // A GraphQL query and a GraphQL mutation are both POSTs, so the document
      // decides rather than the HTTP method.
      /^\s*mutation\b/.test(query),
    );
    if (!response.ok) throw await httpError(response, label, requestId);
    const payload = await response.json();
    if (!record(payload)) throw failure("github_response_invalid", `${label} returned a non-object response`);
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const first = payload.errors.find(record) ?? {};
      const type = typeof first.type === "string" ? first.type : "GRAPHQL_ERROR";
      const message = typeof first.message === "string" ? first.message : `${label} failed`;
      const retryable = type === "RATE_LIMITED";
      if (type === "NOT_FOUND" || type === "FORBIDDEN" || type === "UNPROCESSABLE") {
        throw conflict(`github_graphql_${type.toLowerCase()}`, `${label}: ${message}`, requestId);
      }
      throw failure(`github_graphql_${type.toLowerCase()}`, `${label}: ${message}`, retryable, requestId);
    }
    if (!record(payload.data)) throw failure("github_response_invalid", `${label} returned no data`);
    return payload.data;
  }
}

async function httpError(response: Response, label: string, requestId?: string): Promise<GitHubEffectError> {
  let detail = "";
  try {
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (record(parsed) && typeof parsed.message === "string") detail = `: ${parsed.message}`;
  } catch {
    // A non-JSON error body carries no additional actionable information.
  }
  const status = response.status;
  if (status === 409 || status === 422) {
    return conflict("github_precondition_rejected", `${label} was rejected by GitHub (${status})${detail}`, requestId);
  }
  if (status === 429 || status >= 500) {
    return failure("github_unavailable", `${label} failed (${status})${detail}`, true, requestId);
  }
  return failure("github_http_error", `${label} failed (${status})${detail}`, false, requestId);
}

/* -------------------------------------------------------------------------- */
/* Shared lookups                                                              */
/* -------------------------------------------------------------------------- */

interface ExecutionScope {
  api: GitHubApi;
  repoPath: string;
  owner: string;
  name: string;
  actorLogin: string;
  actorAppSlug: string;
  operationHash: string;
  readCapturedFile?: GitHubEffectsContext["readCapturedFile"];
  chainedResourceVersion?: string;
  /** Set once this attempt has verified the resource's `updated_at` precondition. */
  versionVerified: boolean;
}

/**
 * Matches a GraphQL author login against the writer identity.
 *
 * REST reports the Actions bot as `github-actions[bot]`, but GraphQL exposes the
 * same account as a `Bot` node whose `login` is bare `github-actions`. Comparing
 * only the REST spelling makes every discussion reconciliation miss, which would
 * post a duplicate comment on each retry.
 */
function isActorLogin(login: string, scope: ExecutionScope): boolean {
  const candidate = login.toLowerCase();
  const rest = scope.actorLogin.toLowerCase();
  return candidate === rest || candidate === rest.replace(/\[bot\]$/, "");
}

function authoredByActor(value: JsonRecord, scope: ExecutionScope): boolean {
  if (record(value.performed_via_github_app) && typeof value.performed_via_github_app.slug === "string") {
    if (value.performed_via_github_app.slug.toLowerCase() === scope.actorAppSlug.toLowerCase()) return true;
  }
  return record(value.user)
    && typeof value.user.login === "string"
    && value.user.login.toLowerCase() === scope.actorLogin.toLowerCase();
}

async function loadIssue(scope: ExecutionScope, issueNumber: number, expectPull: boolean): Promise<JsonRecord> {
  const { data } = await scope.api.rest(`${scope.repoPath}/issues/${issueNumber}`, "Issue precondition lookup");
  if (!record(data) || (data.state !== "open" && data.state !== "closed")) {
    throw failure("github_response_invalid", "GitHub issue response was invalid");
  }
  const isPull = data.pull_request !== undefined;
  if (isPull !== expectPull) {
    throw conflict(
      "resource_kind_mismatch",
      expectPull ? "Referenced resource is an issue, not a pull request" : "Referenced resource is a pull request, not an issue",
    );
  }
  return data;
}

function assertIssueState(scope: ExecutionScope, issue: JsonRecord, expectedState: string, expectedUpdatedAt: string): void {
  if (issue.state !== expectedState) {
    throw conflict("issue_state_changed", `Precondition failed: issue state is ${String(issue.state)}`);
  }
  if (!atExpectedVersion(scope, issue.updated_at, expectedUpdatedAt)) {
    throw conflict("issue_changed", "Precondition failed: issue changed after the operation was planned");
  }
}

async function loadPull(scope: ExecutionScope, pullNumber: number): Promise<JsonRecord> {
  const { data } = await scope.api.rest(`${scope.repoPath}/pulls/${pullNumber}`, "Pull request precondition lookup");
  if (!record(data) || !positiveInteger(data.number) || !record(data.head) || !record(data.base)) {
    throw failure("github_response_invalid", "GitHub pull request response was invalid");
  }
  return data;
}

interface PullRevisionExpectation {
  expectedHeadSha: string;
  expectedBaseRef: string;
  expectedBaseSha: string;
}

function assertPullRevision(pull: JsonRecord, expected: PullRevisionExpectation): void {
  const head = record(pull.head) && typeof pull.head.sha === "string" ? pull.head.sha : null;
  if (head !== expected.expectedHeadSha) {
    throw conflict("pull_head_changed", `Precondition failed: pull request head is ${String(head)}`);
  }
  if (!record(pull.base) || typeof pull.base.ref !== "string" || typeof pull.base.sha !== "string") {
    throw failure("github_response_invalid", "Pull request base revision was missing");
  }
  if (pull.base.ref !== expected.expectedBaseRef || pull.base.sha !== expected.expectedBaseSha) {
    throw conflict("pull_base_changed", `Precondition failed: pull request base is ${pull.base.ref} at ${pull.base.sha}`);
  }
}

interface PullStateExpectation {
  expectedState: string;
  expectedDraft: boolean;
  expectedPullUpdatedAt: string;
}

function assertPullState(scope: ExecutionScope, pull: JsonRecord, expected: PullStateExpectation): void {
  if (pull.state !== expected.expectedState) {
    throw conflict("pull_state_changed", `Precondition failed: pull request state is ${String(pull.state)}`);
  }
  if (pull.draft !== expected.expectedDraft) {
    throw conflict("pull_draft_changed", "Precondition failed: pull request draft state changed");
  }
  if (!atExpectedVersion(scope, pull.updated_at, expected.expectedPullUpdatedAt)) {
    throw conflict("pull_changed", "Precondition failed: pull request changed after the operation was planned");
  }
}

async function loadRef(scope: ExecutionScope, ref: string): Promise<string | null> {
  const result = await scope.api.restOptional(`${scope.repoPath}/git/ref/${ref}`, "Git reference lookup");
  if (result === null) return null;
  const { data } = result;
  if (!record(data) || !record(data.object) || typeof data.object.sha !== "string") {
    throw failure("github_response_invalid", "GitHub reference response was invalid");
  }
  return data.object.sha;
}

/** Resolves a numeric GitHub account id to its current login. */
async function resolveLogin(scope: ExecutionScope, accountId: string): Promise<string> {
  const result = await scope.api.restOptional(`/user/${encodeURIComponent(accountId)}`, "GitHub account lookup");
  if (result === null) throw conflict("account_not_found", `GitHub account ${accountId} no longer exists`);
  const { data } = result;
  if (!record(data) || typeof data.login !== "string" || String(data.id) !== accountId) {
    throw failure("github_response_invalid", "GitHub account response was invalid");
  }
  return data.login;
}

function accountIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (record(item) && positiveInteger(item.id) ? [String(item.id)] : []));
}

function labelNames(issue: JsonRecord): string[] {
  if (!Array.isArray(issue.labels)) return [];
  return issue.labels.flatMap((label) => (record(label) && typeof label.name === "string" ? [label.name] : []));
}

/* -------------------------------------------------------------------------- */
/* Issue family                                                                */
/* -------------------------------------------------------------------------- */

type LabelOperation = Extract<Operation, { kind: "issue.label.add" | "issue.label.remove" }>;

async function executeLabel(scope: ExecutionScope, operation: LabelOperation): Promise<OperationOutputsV1> {
  // Validated before any request so a path-rewriting name fails closed on both
  // the add and remove paths, including the reconcile shortcuts below.
  const encodedLabel = encodeSegment(operation.label, "Label name");
  const issue = await loadIssue(scope, operation.issueNumber, false);
  const labels = labelNames(issue);
  const present = labels.some((label) => label.toLowerCase() === operation.label.toLowerCase());
  const desired = operation.kind === "issue.label.add";
  if (present === desired) {
    return { kind: operation.kind, issueNumber: operation.issueNumber, label: operation.label, labels };
  }
  assertIssueState(scope, issue, operation.expectedIssueState, operation.expectedIssueUpdatedAt);
  if (desired) {
    // `POST /issues/{n}/labels` silently creates an unknown label, inventing
    // repository taxonomy as a side effect. Require it to exist already.
    const defined = await scope.api.restOptional(
      `${scope.repoPath}/labels/${encodedLabel}`,
      "Repository label lookup",
    );
    if (defined === null) {
      throw conflict("label_not_defined", `Label ${operation.label} is not defined in this repository`);
    }
  }
  const issuePath = `${scope.repoPath}/issues/${operation.issueNumber}`;
  const { data } = desired
    ? await scope.api.rest(`${issuePath}/labels`, "Issue label add", {
      method: "POST",
      body: JSON.stringify({ labels: [operation.label] }),
    })
    : await scope.api.rest(`${issuePath}/labels/${encodedLabel}`, "Issue label remove", {
      method: "DELETE",
    });
  const applied = Array.isArray(data)
    ? data.flatMap((label) => (record(label) && typeof label.name === "string" ? [label.name] : []))
    : labels;
  return { kind: operation.kind, issueNumber: operation.issueNumber, label: operation.label, labels: applied };
}

type IssueCommentCreate = Extract<Operation, { kind: "issue.comment.create" }>;

async function executeIssueCommentCreate(
  scope: ExecutionScope,
  operation: IssueCommentCreate,
): Promise<OperationOutputsV1> {
  if (!hasExactOperationMarker(operation.body, operation.id)) {
    throw failure("canonical_marker_missing", "Exact issue comment body is missing its operation marker");
  }
  const issuePath = `${scope.repoPath}/issues/${operation.issueNumber}`;
  const existing = await scope.api.findPaginated(
    `${issuePath}/comments?sort=created&direction=desc`,
    "Issue comment idempotency lookup",
    (candidate) => authoredByActor(candidate, scope) && candidate.body === operation.body,
  );
  if (existing) {
    return {
      kind: operation.kind,
      issueNumber: operation.issueNumber,
      commentId: numericId(existing.id, "comment id"),
      commentUrl: htmlUrl(existing),
    };
  }
  const issue = await loadIssue(scope, operation.issueNumber, false);
  assertIssueState(scope, issue, operation.expectedIssueState, operation.expectedIssueUpdatedAt);
  const { data } = await scope.api.rest(`${issuePath}/comments`, "Issue comment creation", {
    method: "POST",
    body: JSON.stringify({ body: operation.body }),
  });
  if (!record(data)) throw failure("github_response_invalid", "Issue comment response was invalid");
  return {
    kind: operation.kind,
    issueNumber: operation.issueNumber,
    commentId: numericId(data.id, "comment id"),
    commentUrl: htmlUrl(data),
  };
}

type CommentUpdate = Extract<Operation, { kind: "issue.comment.update" | "pull_request.comment.update" }>;

async function executeCommentUpdate(
  scope: ExecutionScope,
  operation: CommentUpdate,
  containerNumber: number,
  assertContainer: () => Promise<void>,
): Promise<{ commentId: string; commentUrl: string }> {
  const commentPath = `${scope.repoPath}/issues/comments/${operation.commentId}`;
  const existingResult = await scope.api.restOptional(commentPath, "Comment lookup");
  if (existingResult === null) throw conflict("comment_missing", "Target comment no longer exists");
  const existing = existingResult.data;
  if (!record(existing)) throw failure("github_response_invalid", "Comment response was invalid");
  const expectedIssueUrl = `${scope.api.baseUrl}${scope.repoPath}/issues/${containerNumber}`;
  if (existing.issue_url !== expectedIssueUrl) {
    throw conflict("comment_out_of_scope", "Comment does not belong to the bound issue or pull request");
  }
  if (!authoredByActor(existing, scope)) {
    throw conflict("comment_not_owned", `Only comments authored by ${scope.actorLogin} may be updated`);
  }
  // Reconciliation runs before container preconditions: editing a comment bumps
  // the parent issue's own `updated_at`, so a retry would otherwise self-conflict.
  if (existing.body === operation.body) {
    return { commentId: numericId(existing.id, "comment id"), commentUrl: htmlUrl(existing) };
  }
  await assertContainer();
  if (!sameInstant(existing.updated_at, operation.expectedCommentUpdatedAt)) {
    throw conflict("comment_changed", "Precondition failed: comment changed after the operation was planned");
  }
  const { data } = await scope.api.rest(commentPath, "Comment update", {
    method: "PATCH",
    body: JSON.stringify({ body: operation.body }),
  });
  if (!record(data)) throw failure("github_response_invalid", "Comment update response was invalid");
  return { commentId: numericId(data.id, "comment id"), commentUrl: htmlUrl(data) };
}

type IssueStateOperation = Extract<Operation, { kind: "issue.close" | "issue.reopen" }>;

async function executeIssueState(scope: ExecutionScope, operation: IssueStateOperation): Promise<OperationOutputsV1> {
  const desired = operation.kind === "issue.close" ? "closed" : "open";
  const issue = await loadIssue(scope, operation.issueNumber, false);
  if (issue.state === desired) {
    return { kind: operation.kind, issueNumber: operation.issueNumber, state: desired, issueUrl: htmlUrl(issue) };
  }
  assertIssueState(scope, issue, operation.expectedIssueState, operation.expectedIssueUpdatedAt);
  const { data } = await scope.api.rest(`${scope.repoPath}/issues/${operation.issueNumber}`, "Issue state mutation", {
    method: "PATCH",
    body: JSON.stringify({ state: desired }),
  });
  if (!record(data) || data.state !== desired) {
    throw conflict("issue_state_not_applied", "GitHub did not apply the exact issue state");
  }
  return { kind: operation.kind, issueNumber: operation.issueNumber, state: desired, issueUrl: htmlUrl(data) };
}

type AssigneeOperation = Extract<Operation, { kind: "issue.assignee.add" | "issue.assignee.remove" }>;

async function executeAssignee(scope: ExecutionScope, operation: AssigneeOperation): Promise<OperationOutputsV1> {
  const issue = await loadIssue(scope, operation.issueNumber, false);
  const current = accountIds(issue.assignees);
  const desired = operation.kind === "issue.assignee.add";
  const login = await resolveLogin(scope, operation.assigneeId);
  if (current.includes(operation.assigneeId) === desired) {
    return {
      kind: operation.kind,
      issueNumber: operation.issueNumber,
      assigneeId: operation.assigneeId,
      assigneeLogin: login,
      assigneeIds: current,
    };
  }
  assertIssueState(scope, issue, operation.expectedIssueState, operation.expectedIssueUpdatedAt);
  const issuePath = `${scope.repoPath}/issues/${operation.issueNumber}/assignees`;
  const { data } = await scope.api.rest(issuePath, desired ? "Issue assignee add" : "Issue assignee remove", {
    method: desired ? "POST" : "DELETE",
    body: JSON.stringify({ assignees: [login] }),
  });
  if (!record(data)) throw failure("github_response_invalid", "Issue assignee response was invalid");
  const applied = accountIds(data.assignees);
  // GitHub silently ignores assignees without repository write access.
  if (applied.includes(operation.assigneeId) !== desired) {
    throw conflict(
      "assignee_not_applied",
      `GitHub did not ${desired ? "add" : "remove"} assignee ${login}; the account may lack repository write access`,
    );
  }
  return {
    kind: operation.kind,
    issueNumber: operation.issueNumber,
    assigneeId: operation.assigneeId,
    assigneeLogin: login,
    assigneeIds: applied,
  };
}

/* -------------------------------------------------------------------------- */
/* Pull request family                                                         */
/* -------------------------------------------------------------------------- */

type PullCommentCreate = Extract<Operation, { kind: "pull_request.comment.create" }>;

async function executePullCommentCreate(
  scope: ExecutionScope,
  operation: PullCommentCreate,
): Promise<OperationOutputsV1> {
  // The canonical contract forbids reserved markers on this kind, so exact body
  // equality plus authorship is the only available idempotency signal.
  const issuePath = `${scope.repoPath}/issues/${operation.pullNumber}`;
  const existing = await scope.api.findPaginated(
    `${issuePath}/comments?sort=created&direction=desc`,
    "Pull request comment idempotency lookup",
    (candidate) => authoredByActor(candidate, scope) && candidate.body === operation.body,
  );
  if (existing) {
    return {
      kind: operation.kind,
      pullNumber: operation.pullNumber,
      commentId: numericId(existing.id, "comment id"),
      commentUrl: htmlUrl(existing),
    };
  }
  const pull = await loadPull(scope, operation.pullNumber);
  assertPullRevision(pull, operation);
  assertPullState(scope, pull, operation);
  const { data } = await scope.api.rest(`${issuePath}/comments`, "Pull request comment creation", {
    method: "POST",
    body: JSON.stringify({ body: operation.body }),
  });
  if (!record(data)) throw failure("github_response_invalid", "Pull request comment response was invalid");
  return {
    kind: operation.kind,
    pullNumber: operation.pullNumber,
    commentId: numericId(data.id, "comment id"),
    commentUrl: htmlUrl(data),
  };
}

type PullCommentUpdate = Extract<Operation, { kind: "pull_request.comment.update" }>;

async function executePullCommentUpdate(
  scope: ExecutionScope,
  operation: PullCommentUpdate,
): Promise<OperationOutputsV1> {
  const result = await executeCommentUpdate(scope, operation, operation.pullNumber, async () => {
    const pull = await loadPull(scope, operation.pullNumber);
    assertPullRevision(pull, operation);
    assertPullState(scope, pull, operation);
  });
  return { kind: operation.kind, pullNumber: operation.pullNumber, ...result };
}

type ReviewSubmit = Extract<Operation, { kind: "pull_request.review.submit" }>;

async function executeReviewSubmit(scope: ExecutionScope, operation: ReviewSubmit): Promise<OperationOutputsV1> {
  if (!hasExactOperationMarker(operation.body, operation.id)) {
    throw failure("canonical_marker_missing", "Exact review body is missing its operation marker");
  }
  const expectedState = operation.event === "approve"
    ? "APPROVED"
    : operation.event === "request_changes"
      ? "CHANGES_REQUESTED"
      : "COMMENTED";
  const existing = await scope.api.findPaginated(
    `${scope.repoPath}/pulls/${operation.pullNumber}/reviews`,
    "Review idempotency lookup",
    (candidate) => authoredByActor(candidate, scope)
      && candidate.state === expectedState
      && candidate.commit_id === operation.expectedHeadSha
      && candidate.body === operation.body,
  );
  if (existing) {
    return {
      kind: operation.kind,
      pullNumber: operation.pullNumber,
      reviewId: numericId(existing.id, "review id"),
      reviewUrl: htmlUrl(existing),
      reviewState: expectedState,
    };
  }
  const pull = await loadPull(scope, operation.pullNumber);
  assertPullRevision(pull, operation);
  assertPullState(scope, pull, operation);
  const { data } = await scope.api.rest(`${scope.repoPath}/pulls/${operation.pullNumber}/reviews`, "Pull request review", {
    method: "POST",
    body: JSON.stringify({
      commit_id: operation.expectedHeadSha,
      event: operation.event.toUpperCase(),
      body: operation.body,
      comments: operation.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
      })),
    }),
  });
  if (!record(data)) throw failure("github_response_invalid", "GitHub review response was invalid");
  return {
    kind: operation.kind,
    pullNumber: operation.pullNumber,
    reviewId: numericId(data.id, "review id"),
    reviewUrl: htmlUrl(data),
    reviewState: typeof data.state === "string" ? data.state : expectedState,
  };
}

type ReviewerOperation = Extract<Operation, { kind: "pull_request.reviewer.request" | "pull_request.reviewer.remove" }>;

async function executeReviewer(scope: ExecutionScope, operation: ReviewerOperation): Promise<OperationOutputsV1> {
  const desired = operation.kind === "pull_request.reviewer.request";
  const pull = await loadPull(scope, operation.pullNumber);
  const current = accountIds(pull.requested_reviewers);
  const logins: string[] = [];
  for (const reviewerId of operation.reviewerIds) logins.push(await resolveLogin(scope, reviewerId));
  const settled = operation.reviewerIds.every((reviewerId) => current.includes(reviewerId) === desired);
  if (settled) {
    return { kind: operation.kind, pullNumber: operation.pullNumber, reviewerIds: operation.reviewerIds, reviewerLogins: logins };
  }
  assertPullRevision(pull, operation);
  assertPullState(scope, pull, operation);
  const { data } = await scope.api.rest(
    `${scope.repoPath}/pulls/${operation.pullNumber}/requested_reviewers`,
    desired ? "Reviewer request" : "Reviewer removal",
    { method: desired ? "POST" : "DELETE", body: JSON.stringify({ reviewers: logins }) },
  );
  if (!record(data)) throw failure("github_response_invalid", "Reviewer mutation response was invalid");
  const applied = accountIds(data.requested_reviewers);
  const unsatisfied = operation.reviewerIds.filter((reviewerId) => applied.includes(reviewerId) !== desired);
  if (unsatisfied.length > 0) {
    throw conflict(
      "reviewer_not_applied",
      `GitHub did not ${desired ? "request" : "remove"} reviewers ${unsatisfied.join(", ")}; they may not be collaborators`,
    );
  }
  return { kind: operation.kind, pullNumber: operation.pullNumber, reviewerIds: operation.reviewerIds, reviewerLogins: logins };
}

type PullUpdate = Extract<Operation, { kind: "pull_request.update" }>;

function pullMatchesUpdate(pull: JsonRecord, operation: PullUpdate): boolean {
  return (operation.title === undefined || pull.title === operation.title)
    && (operation.body === undefined || pull.body === operation.body)
    && (operation.state === undefined || pull.state === operation.state)
    && (operation.draft === undefined || pull.draft === operation.draft);
}

function pullUpdateOutputs(operation: PullUpdate, pull: JsonRecord): OperationOutputsV1 {
  if (typeof pull.title !== "string" || (pull.state !== "open" && pull.state !== "closed")) {
    throw failure("github_response_invalid", "GitHub pull request response omitted its title or state");
  }
  return {
    kind: operation.kind,
    pullNumber: operation.pullNumber,
    pullUrl: htmlUrl(pull),
    title: pull.title,
    state: pull.state,
    draft: pull.draft === true,
  };
}

async function setPullDraft(scope: ExecutionScope, nodeId: string, draft: boolean): Promise<void> {
  const mutation = draft
    ? "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}"
    : "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}";
  const field = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  const data = await scope.api.graphql(mutation, { id: nodeId }, "Pull request draft transition");
  const payload = data[field];
  if (!record(payload) || !record(payload.pullRequest) || payload.pullRequest.isDraft !== draft) {
    throw conflict("pull_draft_not_applied", "GitHub did not update the pull request draft state");
  }
}

async function executePullUpdate(scope: ExecutionScope, operation: PullUpdate): Promise<OperationOutputsV1> {
  let current = await loadPull(scope, operation.pullNumber);
  // Reconcile before asserting any precondition. A retry after a successful
  // update can legitimately observe a moved head or a bumped `updated_at` that
  // this very operation caused, and must not self-conflict on it.
  if (pullMatchesUpdate(current, operation)) return pullUpdateOutputs(operation, current);
  assertPullRevision(current, operation);
  // A retry that already applied the draft transition legitimately observes a
  // different draft state than the planned expectation.
  const resumedAfterDraft = operation.draft !== undefined
    && operation.draft !== operation.expectedDraft
    && current.draft === operation.draft;
  if (!resumedAfterDraft) assertPullState(scope, current, operation);

  if (operation.draft !== undefined && current.draft !== operation.draft) {
    if (typeof current.node_id !== "string") throw failure("github_response_invalid", "Pull request node id was missing");
    await setPullDraft(scope, current.node_id, operation.draft);
    current = await loadPull(scope, operation.pullNumber);
    assertPullRevision(current, operation);
    if (current.draft !== operation.draft) {
      throw conflict("pull_draft_not_applied", "GitHub did not apply the exact pull request draft state");
    }
  }

  const patch: Record<string, unknown> = {};
  if (operation.title !== undefined && current.title !== operation.title) patch.title = operation.title;
  if (operation.body !== undefined && current.body !== operation.body) patch.body = operation.body;
  if (operation.state !== undefined && current.state !== operation.state) patch.state = operation.state;
  if (Object.keys(patch).length > 0) {
    const { data } = await scope.api.rest(`${scope.repoPath}/pulls/${operation.pullNumber}`, "Pull request update", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!record(data)) throw failure("github_response_invalid", "Pull request update response was invalid");
    current = data;
    assertPullRevision(current, operation);
  }
  if (!pullMatchesUpdate(current, operation)) {
    throw conflict("pull_update_not_applied", "GitHub did not apply the exact pull request update");
  }
  return pullUpdateOutputs(operation, current);
}

/* -------------------------------------------------------------------------- */
/* Git family                                                                  */
/* -------------------------------------------------------------------------- */

type BranchCreate = Extract<Operation, { kind: "branch.create" }>;

async function executeBranchCreate(scope: ExecutionScope, operation: BranchCreate): Promise<OperationOutputsV1> {
  if (!isValidGitBranchName(operation.branch) || !operation.branch.startsWith("gardener/")) {
    throw failure("branch_namespace_violation", "Branch name must use the gardener/ namespace");
  }
  const branchUrl = `https://github.com/${scope.owner}/${scope.name}/tree/${encodeRefPath(operation.branch)}`;
  const existing = await loadRef(scope, `heads/${encodeRefPath(operation.branch)}`);
  if (existing !== null) {
    if (existing === operation.fromSha) {
      return {
        kind: operation.kind,
        branch: operation.branch,
        ref: `refs/heads/${operation.branch}`,
        commitSha: existing,
        branchUrl,
      };
    }
    throw conflict("branch_exists", `Branch already exists at ${existing}, not ${operation.fromSha}`);
  }
  const { data } = await scope.api.rest(`${scope.repoPath}/git/refs`, "Branch creation", {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${operation.branch}`, sha: operation.fromSha }),
  });
  if (!record(data) || !record(data.object) || typeof data.object.sha !== "string") {
    throw failure("github_response_invalid", "Branch creation response was invalid");
  }
  return {
    kind: operation.kind,
    branch: operation.branch,
    ref: `refs/heads/${operation.branch}`,
    commitSha: data.object.sha,
    branchUrl,
  };
}

type CommitCreate = Extract<Operation, { kind: "commit.create" }>;
type CommitFile = CommitCreate["files"][number];
/**
 * Reads one captured file and re-proves it before it can be uploaded.
 *
 * The capture artifact was verified as a whole before the plan's first write,
 * but that proof covered the artifact, not this read. Re-checking the size and
 * digest here means a truncated read, a reader bug, or a file changed on the
 * runner between verification and upload cannot become a blob: the digest in
 * the operation is the same value the plan and the receipt are bound to, so
 * matching it is what makes "the commit contains exactly what was captured" a
 * checked statement rather than an assumption.
 */
async function readVerifiedCapturedContent(
  scope: ExecutionScope,
  file: CommitFile,
): Promise<string> {
  if (file.captured.status === "deleted") throw new Error("A deleted capture entry has no content to read");
  const reader = scope.readCapturedFile;
  if (reader === undefined) throw new Error("No capture reader was provided");
  const { sha256, sizeBytes } = file.captured;
  let bytes: Uint8Array;
  try {
    bytes = await reader({ path: file.path, sha256, sizeBytes });
  } catch (cause) {
    throw failure("capture_content_unreadable", `Captured content for ${file.path} could not be read: ${cause instanceof Error ? cause.message : "unknown error"}`);
  }
  if (bytes.byteLength !== sizeBytes) {
    throw failure("capture_content_mismatch", `Captured content for ${file.path} is ${bytes.byteLength} bytes, not the recorded ${sizeBytes}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) {
    throw failure("capture_content_mismatch", `Captured content for ${file.path} does not match its recorded digest`);
  }
  return Buffer.from(bytes).toString("base64");
}

async function executeCommitCreate(scope: ExecutionScope, operation: CommitCreate): Promise<OperationOutputsV1> {
  if (!isValidGitBranchName(operation.branch) || !operation.branch.startsWith("gardener/")) {
    throw failure("branch_namespace_violation", "Commit target must use the gardener/ branch namespace");
  }
  if (operation.files.some((file) => !isSafeFilePath(file.path))) {
    throw failure("invalid_commit_path", "Commit contains an invalid file path");
  }
  // Re-checked here, against the same helper the capture manifest and the
  // instance policy use, so the three cannot disagree about what "protected"
  // means. This is the last check before a write, and the only one that sees
  // the final path set.
  if (operation.files.some((file) => isProtectedCapturePath(file.path))) {
    throw failure("protected_commit_path", "Commit touches a protected repository path");
  }
  if (operation.files.some((file) => file.captured.status !== "deleted") && scope.readCapturedFile === undefined) {
    // A caller defect, not an operation outcome: the plan asked for content the
    // executor was given no way to read. Failing here keeps the alternative —
    // committing an empty or partial tree — unrepresentable.
    throw new Error("commit.create requires capture-backed content but no capture reader was provided");
  }
  const marker = commitMarker(operation.id, scope.operationHash);
  const head = await loadRef(scope, `heads/${encodeRefPath(operation.branch)}`);
  if (head === null) throw conflict("branch_missing", "Target branch does not exist");
  if (head !== operation.expectedHeadSha) {
    const matched = await scope.api.findPaginated(
      `${scope.repoPath}/commits?sha=${encodeURIComponent(operation.branch)}`,
      "Commit idempotency lookup",
      (candidate) => {
        const message = record(candidate.commit) ? candidate.commit.message : undefined;
        const parent = Array.isArray(candidate.parents) && record(candidate.parents[0]) ? candidate.parents[0].sha : undefined;
        return typeof candidate.sha === "string"
          && typeof message === "string"
          && message.split(/\r?\n/).includes(marker)
          && parent === operation.expectedHeadSha;
      },
    );
    if (matched && typeof matched.sha === "string") {
      // Downstream steps reference `treeSha`, so an unreadable tree must fail
      // rather than resolve to an empty placeholder.
      if (!record(matched.commit) || !record(matched.commit.tree) || typeof matched.commit.tree.sha !== "string") {
        throw failure("github_response_invalid", "Reconciled commit response omitted its tree sha");
      }
      const treeSha = matched.commit.tree.sha;
      return {
        kind: operation.kind,
        branch: operation.branch,
        commitSha: matched.sha,
        treeSha,
        parentSha: operation.expectedHeadSha,
        commitUrl: `https://github.com/${scope.owner}/${scope.name}/commit/${matched.sha}`,
      };
    }
    throw conflict("branch_head_changed", `Precondition failed: branch head is ${head}`);
  }
  const { data: parent } = await scope.api.rest(
    `${scope.repoPath}/git/commits/${encodeURIComponent(operation.expectedHeadSha)}`,
    "Parent commit lookup",
  );
  if (!record(parent) || !record(parent.tree) || typeof parent.tree.sha !== "string") {
    throw failure("github_response_invalid", "Parent commit response was invalid");
  }
  const { data: parentTree } = await scope.api.rest(
    `${scope.repoPath}/git/trees/${encodeURIComponent(parent.tree.sha)}?recursive=1`,
    "Parent tree lookup",
  );
  if (!record(parentTree) || !Array.isArray(parentTree.tree) || parentTree.truncated === true) {
    throw failure("github_tree_truncated", "Parent tree response was invalid or truncated");
  }
  const existingEntries = new Map(parentTree.tree.flatMap(
    (entry) => (record(entry) && typeof entry.path === "string" ? [[entry.path, entry] as const] : []),
  ));
  const tree: Array<Record<string, unknown>> = [];
  for (const file of operation.files) {
    const existing = existingEntries.get(file.path);
    const existingMode = existing?.mode;
    const supportedModes = ["100644", "100755", "120000"];
    if (existing && (existing.type !== "blob" || typeof existingMode !== "string" || !supportedModes.includes(existingMode))) {
      throw conflict("unsupported_git_object", `Commit cannot replace unsupported Git object: ${file.path}`);
    }
    if (file.captured.status === "deleted") {
      if (!existing) throw conflict("delete_target_missing", `Commit cannot delete absent path: ${file.path}`);
      tree.push({ path: file.path, mode: existingMode as string, type: "blob", sha: null });
      continue;
    }
    // A capture recorded the mode it observed on disk, so it is authoritative:
    // a newly executable script has to land as `100755` even though the path it
    // replaces was `100644`.
    const mode = file.captured.mode;
    // One blob at a time. The bytes of a capture-backed file are read, encoded,
    // uploaded, and dropped before the next path is touched, so peak memory is
    // a function of the largest single file rather than of the change set.
    const content = await readVerifiedCapturedContent(scope, file);
    const { data: blob } = await scope.api.rest(`${scope.repoPath}/git/blobs`, "Git blob creation", {
      method: "POST",
      body: JSON.stringify({ content, encoding: "base64" }),
    });
    if (!record(blob) || typeof blob.sha !== "string") throw failure("github_response_invalid", "Git blob response was invalid");
    tree.push({ path: file.path, mode, type: "blob", sha: blob.sha });
  }
  const { data: createdTree } = await scope.api.rest(`${scope.repoPath}/git/trees`, "Git tree creation", {
    method: "POST",
    body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
  });
  if (!record(createdTree) || typeof createdTree.sha !== "string") {
    throw failure("github_response_invalid", "Git tree response was invalid");
  }
  const { data: createdCommit } = await scope.api.rest(`${scope.repoPath}/git/commits`, "Git commit creation", {
    method: "POST",
    body: JSON.stringify({
      message: `${operation.message}\n\n${marker}`,
      tree: createdTree.sha,
      parents: [operation.expectedHeadSha],
    }),
  });
  if (!record(createdCommit) || typeof createdCommit.sha !== "string") {
    throw failure("github_response_invalid", "Git commit response was invalid");
  }
  await scope.api.rest(
    `${scope.repoPath}/git/refs/heads/${encodeRefPath(operation.branch)}`,
    "Branch fast-forward",
    { method: "PATCH", body: JSON.stringify({ sha: createdCommit.sha, force: false }) },
  );
  return {
    kind: operation.kind,
    branch: operation.branch,
    commitSha: createdCommit.sha,
    treeSha: createdTree.sha,
    parentSha: operation.expectedHeadSha,
    commitUrl: `https://github.com/${scope.owner}/${scope.name}/commit/${createdCommit.sha}`,
  };
}

type PullOpenDraft = Extract<Operation, { kind: "pull_request.open_draft" }>;

function draftPullOutputs(operation: PullOpenDraft, pull: JsonRecord): OperationOutputsV1 {
  // Later plan steps reference these by name, so an unresolvable field must
  // fail here rather than hand a placeholder to a downstream operation.
  if (!positiveInteger(pull.number)) {
    throw failure("github_response_invalid", "GitHub pull request response omitted its number");
  }
  if (typeof pull.node_id !== "string" || pull.node_id === "") {
    throw failure("github_response_invalid", "GitHub pull request response omitted its node id");
  }
  return {
    kind: operation.kind,
    pullNumber: pull.number,
    pullUrl: htmlUrl(pull),
    pullNodeId: pull.node_id,
    headRef: operation.head,
    headSha: operation.expectedHeadSha,
    baseRef: operation.base,
  };
}

async function executePullOpenDraft(scope: ExecutionScope, operation: PullOpenDraft): Promise<OperationOutputsV1> {
  if (!isValidGitBranchName(operation.head) || !isValidGitBranchName(operation.base) || !operation.head.startsWith("gardener/")) {
    throw failure("branch_namespace_violation", "Pull request head must use the gardener/ namespace");
  }
  if (!hasExactOperationMarker(operation.body, operation.id)) {
    throw failure("canonical_marker_missing", "Exact pull request body is missing its operation marker");
  }
  const query = new URLSearchParams({ state: "all", head: `${scope.owner}:${operation.head}`, base: operation.base });
  const existing = await scope.api.findPaginated(
    `${scope.repoPath}/pulls?${query.toString()}`,
    "Pull request idempotency lookup",
    (candidate) => authoredByActor(candidate, scope) && candidate.body === operation.body,
  );
  if (existing) {
    // A closed or merged pull request does not satisfy "open a draft pull
    // request", so it must never reconcile as already-applied.
    if (existing.state !== "open") {
      throw conflict(
        "pull_request_not_open",
        `A matching Gardener pull request exists but is ${String(existing.state)}, so the draft was not opened`,
      );
    }
    const headMatches = record(existing.head) && existing.head.sha === operation.expectedHeadSha;
    const baseMatches = record(existing.base) && existing.base.ref === operation.base;
    if (!headMatches || !baseMatches || existing.title !== operation.title || existing.draft !== operation.draft) {
      throw conflict("pull_request_mismatch", "Existing Gardener pull request does not match the planned operation");
    }
    return draftPullOutputs(operation, existing);
  }
  const head = await loadRef(scope, `heads/${encodeRefPath(operation.head)}`);
  const base = await loadRef(scope, `heads/${encodeRefPath(operation.base)}`);
  if (head === null) throw conflict("head_branch_missing", "Pull request head branch does not exist");
  if (base === null) throw conflict("base_branch_missing", "Pull request base branch does not exist");
  if (head !== operation.expectedHeadSha) throw conflict("head_branch_changed", "Precondition failed: head branch changed");
  if (base !== operation.expectedBaseSha) throw conflict("base_branch_changed", "Precondition failed: base branch changed");
  const { data } = await scope.api.rest(`${scope.repoPath}/pulls`, "Pull request creation", {
    method: "POST",
    body: JSON.stringify({
      head: operation.head,
      base: operation.base,
      title: operation.title,
      body: operation.body,
      draft: operation.draft,
    }),
  });
  if (!record(data) || !positiveInteger(data.number) || !record(data.head) || !record(data.base)) {
    throw failure("github_response_invalid", "GitHub pull request creation response was invalid");
  }
  if (data.head.sha !== operation.expectedHeadSha || data.base.ref !== operation.base || data.base.sha !== operation.expectedBaseSha) {
    const { response } = await scope.api.raw(`${scope.repoPath}/pulls/${data.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw conflict(
        "pull_request_revision_race",
        `Pull request revision changed during creation and cleanup failed for #${data.number} (${response.status})`,
      );
    }
    throw conflict("pull_request_revision_race", "Pull request revision changed during creation; the new pull request was closed");
  }
  return draftPullOutputs(operation, data);
}

type PullMerge = Extract<Operation, { kind: "pull_request.merge" }>;

export function successfulChecks(checks: unknown, statuses: unknown): { names: Set<string>; appChecks: Set<string> } {
  const names = new Set<string>();
  const appChecks = new Set<string>();
  if (record(checks) && Array.isArray(checks.check_runs)) {
    for (const check of checks.check_runs) {
      if (!record(check) || !["success", "neutral", "skipped"].includes(String(check.conclusion)) || typeof check.name !== "string") continue;
      names.add(check.name);
      if (record(check.app) && positiveInteger(check.app.id)) appChecks.add(`${check.app.id}:${check.name}`);
    }
  }
  if (record(statuses) && Array.isArray(statuses.statuses)) {
    for (const status of statuses.statuses) {
      if (record(status) && status.state === "success" && typeof status.context === "string") names.add(status.context);
    }
  }
  return { names, appChecks };
}

/**
 * Retained so the compiler can keep producing the canonical
 * `expectedBranchProtectionHash` field required by `operationSchema`. The
 * effects job no longer verifies it — see `executePullMerge`.
 */
export function branchProtectionHash(protection: unknown): string {
  return createHash("sha256").update(canonicalJson(protection), "utf8").digest("hex");
}

/**
 * Merges a pull request under the Actions authority model.
 *
 * Branch protection is deliberately **not** read here. `GET /branches/{branch}/
 * protection` requires repository administration rights, and a workflow
 * `permissions:` block cannot grant `administration` at all — there is no such
 * scope. Neither the planning job nor this effects job can therefore produce or
 * verify `expectedBranchProtectionHash`, so verifying it was never actually
 * possible and pretending to verify it would be worse than not claiming to.
 *
 * What replaces it:
 * - the exact head SHA, base ref, base SHA, open state, and non-draft state are
 *   all bound and re-checked immediately before the merge call;
 * - the exact required check and commit status snapshot the plan was built from
 *   is re-verified against live results at the planned head SHA;
 * - the merge method is bound and validated against repository settings;
 * - authority to merge at all comes from the task declaration and exact plan;
 *   workflow layers, not by this executor;
 * - GitHub itself enforces branch protection on the merge call and rejects the
 *   request when rules are unmet. There is no administrator bypass available to
 *   `GITHUB_TOKEN`, so that rejection is authoritative rather than advisory.
 */
async function executePullMerge(scope: ExecutionScope, operation: PullMerge): Promise<OperationOutputsV1> {
  let pull = await loadPull(scope, operation.pullNumber);
  if (pull.merged === true || typeof pull.merged_at === "string") {
    assertPullRevision(pull, operation);
    const sha = typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : operation.expectedHeadSha;
    return { kind: operation.kind, pullNumber: operation.pullNumber, mergeCommitSha: sha, pullUrl: htmlUrl(pull) };
  }
  assertPullRevision(pull, operation);
  assertPullState(scope, pull, operation);
  if (!record(pull.base) || typeof pull.base.ref !== "string") {
    throw failure("github_response_invalid", "Pull request base branch was missing");
  }
  const { data: repository } = await scope.api.rest(scope.repoPath, "Repository merge settings lookup");
  const methodField = operation.method === "merge"
    ? "allow_merge_commit"
    : operation.method === "squash"
      ? "allow_squash_merge"
      : "allow_rebase_merge";
  if (!record(repository) || repository[methodField] !== true) {
    throw conflict("merge_method_disabled", `Merge method ${operation.method} is not enabled for this repository`);
  }
  const { data: checks } = await scope.api.rest(
    `${scope.repoPath}/commits/${encodeURIComponent(operation.expectedHeadSha)}/check-runs?per_page=100&filter=latest`,
    "Check run lookup",
  );
  const { data: statuses } = await scope.api.rest(
    `${scope.repoPath}/commits/${encodeURIComponent(operation.expectedHeadSha)}/status?per_page=100`,
    "Commit status lookup",
  );
  const successful = successfulChecks(checks, statuses);
  // `requiredChecks` always carries an app id, so a bare context match from an
  // unattributed commit status must never satisfy it. The name set is read only
  // to distinguish "never ran" from "ran green under a different producer".
  const missing = operation.requiredChecks.filter(
    (check) => !successful.appChecks.has(`${check.appId}:${check.context}`),
  );
  if (missing.length > 0) {
    const detail = missing
      .map((check) => (successful.names.has(check.context)
        ? `${check.context} (succeeded, but not from App ${check.appId})`
        : `${check.context} (App ${check.appId})`))
      .join(", ");
    throw conflict("required_checks_incomplete", `Required checks are not successful: ${detail}`);
  }
  pull = await loadPull(scope, operation.pullNumber);
  if (pull.merged === true || typeof pull.merged_at === "string") {
    assertPullRevision(pull, operation);
    const sha = typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : operation.expectedHeadSha;
    return { kind: operation.kind, pullNumber: operation.pullNumber, mergeCommitSha: sha, pullUrl: htmlUrl(pull) };
  }
  assertPullRevision(pull, operation);
  assertPullState(scope, pull, operation);
  const { data: merge } = await scope.api.rest(`${scope.repoPath}/pulls/${operation.pullNumber}/merge`, "Pull request merge", {
    method: "PUT",
    body: JSON.stringify({ sha: operation.expectedHeadSha, merge_method: operation.method }),
  });
  if (!record(merge) || merge.merged !== true || typeof merge.sha !== "string") {
    throw conflict("merge_not_applied", "GitHub did not merge the pull request");
  }
  const merged = await loadPull(scope, operation.pullNumber);
  const mergedHead = record(merged.head) && typeof merged.head.sha === "string" ? merged.head.sha : null;
  const mergedBase = record(merged.base) && typeof merged.base.ref === "string" ? merged.base.ref : null;
  if (mergedHead !== operation.expectedHeadSha || mergedBase !== operation.expectedBaseRef) {
    throw failure("merge_target_changed", "Security incident: pull request target changed during merge");
  }
  return { kind: operation.kind, pullNumber: operation.pullNumber, mergeCommitSha: merge.sha, pullUrl: htmlUrl(merged) };
}

/* -------------------------------------------------------------------------- */
/* Discussion family (GraphQL)                                                 */
/* -------------------------------------------------------------------------- */

const DISCUSSION_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    discussion(number:$number){
      id number url closed updatedAt
      answer{ id databaseId }
    }
  }
}`;

const DISCUSSION_COMMENT_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    discussion(number:$number){
      comments(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id databaseId body url updatedAt author{ login } }
      }
    }
  }
}`;

interface DiscussionNode {
  id: string;
  number: number;
  url: string;
  closed: boolean;
  updatedAt: string;
  answerCommentId: string | null;
  answerNodeId: string | null;
}

async function loadDiscussion(scope: ExecutionScope, number: number): Promise<DiscussionNode> {
  const data = await scope.api.graphql(
    DISCUSSION_QUERY,
    { owner: scope.owner, name: scope.name, number },
    "Discussion precondition lookup",
  );
  const repository = data.repository;
  if (!record(repository) || !record(repository.discussion)) {
    throw conflict("discussion_missing", `Discussion #${number} is unavailable; discussions may be disabled`);
  }
  const discussion = repository.discussion;
  if (typeof discussion.id !== "string" || typeof discussion.updatedAt !== "string" || typeof discussion.url !== "string") {
    throw failure("github_response_invalid", "Discussion response was invalid");
  }
  const answer = record(discussion.answer) ? discussion.answer : null;
  return {
    id: discussion.id,
    number,
    url: discussion.url,
    closed: discussion.closed === true,
    updatedAt: discussion.updatedAt,
    answerCommentId: answer && positiveInteger(answer.databaseId) ? String(answer.databaseId) : null,
    answerNodeId: answer && typeof answer.id === "string" ? answer.id : null,
  };
}

function assertDiscussionState(scope: ExecutionScope, discussion: DiscussionNode, expectedState: string, expectedUpdatedAt: string): void {
  const state = discussion.closed ? "closed" : "open";
  if (state !== expectedState) {
    throw conflict("discussion_state_changed", `Precondition failed: discussion state is ${state}`);
  }
  if (!atExpectedVersion(scope, discussion.updatedAt, expectedUpdatedAt)) {
    throw conflict("discussion_changed", "Precondition failed: discussion changed after the operation was planned");
  }
}

interface DiscussionComment {
  nodeId: string;
  databaseId: string;
  body: string;
  url: string;
  updatedAt: string;
  authorLogin: string;
}

async function findDiscussionComment(
  scope: ExecutionScope,
  number: number,
  matches: (comment: DiscussionComment) => boolean,
): Promise<DiscussionComment | null> {
  let cursor: string | null = null;
  for (let page = 0; page < DEFAULT_MAX_PAGES; page++) {
    const data: JsonRecord = await scope.api.graphql(
      DISCUSSION_COMMENT_QUERY,
      { owner: scope.owner, name: scope.name, number, cursor },
      "Discussion comment lookup",
    );
    const repository = data.repository;
    if (!record(repository) || !record(repository.discussion) || !record(repository.discussion.comments)) {
      throw conflict("discussion_missing", `Discussion #${number} is unavailable`);
    }
    const comments = repository.discussion.comments;
    const nodes = Array.isArray(comments.nodes) ? comments.nodes : [];
    for (const node of nodes) {
      if (!record(node) || typeof node.id !== "string" || !positiveInteger(node.databaseId)) continue;
      const comment: DiscussionComment = {
        nodeId: node.id,
        databaseId: String(node.databaseId),
        body: typeof node.body === "string" ? node.body : "",
        url: typeof node.url === "string" ? node.url : "",
        updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : "",
        authorLogin: record(node.author) && typeof node.author.login === "string" ? node.author.login : "",
      };
      if (matches(comment)) return comment;
    }
    const pageInfo = record(comments.pageInfo) ? comments.pageInfo : {};
    if (pageInfo.hasNextPage !== true || typeof pageInfo.endCursor !== "string") return null;
    cursor = pageInfo.endCursor;
  }
  throw failure("github_pagination_exhausted", "Discussion comment scan exceeded its page ceiling");
}

type DiscussionCommentCreate = Extract<Operation, { kind: "discussion.comment.create" }>;

async function executeDiscussionCommentCreate(
  scope: ExecutionScope,
  operation: DiscussionCommentCreate,
): Promise<OperationOutputsV1> {
  const existing = await findDiscussionComment(
    scope,
    operation.discussionNumber,
    (comment) => isActorLogin(comment.authorLogin, scope) && comment.body === operation.body,
  );
  if (existing) {
    return {
      kind: operation.kind,
      discussionNumber: operation.discussionNumber,
      commentId: existing.databaseId,
      commentNodeId: existing.nodeId,
      commentUrl: existing.url,
    };
  }
  const discussion = await loadDiscussion(scope, operation.discussionNumber);
  assertDiscussionState(scope, discussion, operation.expectedDiscussionState, operation.expectedDiscussionUpdatedAt);
  const data = await scope.api.graphql(
    `mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{id databaseId url}}}`,
    { id: discussion.id, body: operation.body },
    "Discussion comment creation",
  );
  const payload = data.addDiscussionComment;
  if (!record(payload) || !record(payload.comment) || typeof payload.comment.id !== "string") {
    throw failure("github_response_invalid", "Discussion comment creation response was invalid");
  }
  if (typeof payload.comment.url !== "string" || !payload.comment.url.startsWith("https://")) {
    throw failure("github_response_invalid", "Discussion comment response omitted its URL");
  }
  return {
    kind: operation.kind,
    discussionNumber: operation.discussionNumber,
    commentId: numericId(payload.comment.databaseId, "discussion comment id"),
    commentNodeId: payload.comment.id,
    commentUrl: payload.comment.url,
  };
}

type DiscussionCommentUpdate = Extract<Operation, { kind: "discussion.comment.update" }>;

async function executeDiscussionCommentUpdate(
  scope: ExecutionScope,
  operation: DiscussionCommentUpdate,
): Promise<OperationOutputsV1> {
  const target = await findDiscussionComment(
    scope,
    operation.discussionNumber,
    (comment) => comment.databaseId === operation.commentId,
  );
  if (!target) throw conflict("comment_missing", "Target discussion comment no longer exists");
  if (!isActorLogin(target.authorLogin, scope)) {
    throw conflict("comment_not_owned", `Only discussion comments authored by ${scope.actorLogin} may be updated`);
  }
  if (target.body === operation.body) {
    return {
      kind: operation.kind,
      discussionNumber: operation.discussionNumber,
      commentId: target.databaseId,
      commentNodeId: target.nodeId,
      commentUrl: target.url,
    };
  }
  if (!sameInstant(target.updatedAt, operation.expectedCommentUpdatedAt)) {
    throw conflict("comment_changed", "Precondition failed: discussion comment changed after the operation was planned");
  }
  const discussion = await loadDiscussion(scope, operation.discussionNumber);
  assertDiscussionState(scope, discussion, operation.expectedDiscussionState, operation.expectedDiscussionUpdatedAt);
  const data = await scope.api.graphql(
    `mutation($id:ID!,$body:String!){updateDiscussionComment(input:{commentId:$id,body:$body}){comment{id databaseId url body}}}`,
    { id: target.nodeId, body: operation.body },
    "Discussion comment update",
  );
  const payload = data.updateDiscussionComment;
  if (!record(payload) || !record(payload.comment) || payload.comment.body !== operation.body) {
    throw conflict("comment_update_not_applied", "GitHub did not apply the exact discussion comment update");
  }
  return {
    kind: operation.kind,
    discussionNumber: operation.discussionNumber,
    commentId: target.databaseId,
    commentNodeId: target.nodeId,
    commentUrl: typeof payload.comment.url === "string" ? payload.comment.url : target.url,
  };
}

type DiscussionAnswer = Extract<Operation, { kind: "discussion.answer.mark" | "discussion.answer.unmark" }>;

async function executeDiscussionAnswer(scope: ExecutionScope, operation: DiscussionAnswer): Promise<OperationOutputsV1> {
  const discussion = await loadDiscussion(scope, operation.discussionNumber);
  const mark = operation.kind === "discussion.answer.mark";
  const desired = mark ? operation.answerCommentId : null;
  if (discussion.answerCommentId === desired) {
    return { kind: operation.kind, discussionNumber: operation.discussionNumber, answerCommentId: desired };
  }
  if (discussion.answerCommentId !== operation.expectedAnswerCommentId) {
    throw conflict(
      "discussion_answer_changed",
      `Precondition failed: discussion answer is ${discussion.answerCommentId ?? "unset"}`,
    );
  }
  assertDiscussionState(scope, discussion, operation.expectedDiscussionState, operation.expectedDiscussionUpdatedAt);
  if (mark) {
    const target = await findDiscussionComment(
      scope,
      operation.discussionNumber,
      (comment) => comment.databaseId === operation.answerCommentId,
    );
    if (!target) throw conflict("comment_missing", "Answer comment does not exist on this discussion");
    const data = await scope.api.graphql(
      `mutation($id:ID!){markDiscussionCommentAsAnswer(input:{id:$id}){discussion{id}}}`,
      { id: target.nodeId },
      "Discussion answer mark",
    );
    if (!record(data.markDiscussionCommentAsAnswer)) {
      throw conflict("discussion_answer_not_applied", "GitHub did not mark the discussion answer");
    }
    return { kind: operation.kind, discussionNumber: operation.discussionNumber, answerCommentId: operation.answerCommentId };
  }
  if (!discussion.answerNodeId) throw conflict("discussion_answer_missing", "Discussion has no chosen answer to unmark");
  const data = await scope.api.graphql(
    `mutation($id:ID!){unmarkDiscussionCommentAsAnswer(input:{id:$id}){discussion{id}}}`,
    { id: discussion.answerNodeId },
    "Discussion answer unmark",
  );
  if (!record(data.unmarkDiscussionCommentAsAnswer)) {
    throw conflict("discussion_answer_not_applied", "GitHub did not unmark the discussion answer");
  }
  return { kind: operation.kind, discussionNumber: operation.discussionNumber, answerCommentId: null };
}

type DiscussionState = Extract<Operation, { kind: "discussion.close" | "discussion.reopen" }>;

async function executeDiscussionState(scope: ExecutionScope, operation: DiscussionState): Promise<OperationOutputsV1> {
  const close = operation.kind === "discussion.close";
  const discussion = await loadDiscussion(scope, operation.discussionNumber);
  if (discussion.closed === close) {
    return {
      kind: operation.kind,
      discussionNumber: operation.discussionNumber,
      state: close ? "closed" : "open",
      discussionUrl: discussion.url,
    };
  }
  assertDiscussionState(scope, discussion, operation.expectedDiscussionState, operation.expectedDiscussionUpdatedAt);
  const mutation = close
    ? "mutation($id:ID!){closeDiscussion(input:{discussionId:$id}){discussion{id closed url}}}"
    : "mutation($id:ID!){reopenDiscussion(input:{discussionId:$id}){discussion{id closed url}}}";
  const field = close ? "closeDiscussion" : "reopenDiscussion";
  const data = await scope.api.graphql(mutation, { id: discussion.id }, "Discussion state transition");
  const payload = data[field];
  if (!record(payload) || !record(payload.discussion) || payload.discussion.closed !== close) {
    throw conflict("discussion_state_not_applied", "GitHub did not apply the exact discussion state");
  }
  return {
    kind: operation.kind,
    discussionNumber: operation.discussionNumber,
    state: close ? "closed" : "open",
    discussionUrl: typeof payload.discussion.url === "string" ? payload.discussion.url : discussion.url,
  };
}

/* -------------------------------------------------------------------------- */
/* Check family                                                                */
/* -------------------------------------------------------------------------- */

type CheckRerun = Extract<Operation, { kind: "check.rerun" }>;

/**
 * Re-runs a completed check.
 *
 * Two GitHub behaviours drive this implementation:
 *
 * 1. `POST /check-runs/{id}/rerequest` is only permitted for check runs created
 *    by the calling app. `GITHUB_TOKEN` is the `github-actions` app, so a check
 *    produced by any third-party CI provider can never be re-requested here.
 *    That is reported as an explicit conflict instead of letting GitHub return
 *    an opaque 403.
 * 2. Re-requesting does not reset the original check run. GitHub starts a *new*
 *    check run (usually in a new suite) while the original keeps its completed
 *    conclusion forever. Reconciling on the original run's own status would
 *    therefore never observe the rerun and would re-trigger the workflow on
 *    every retry, so reconciliation looks for a newer run of the same name on
 *    the same head instead.
 */
async function executeCheckRerun(scope: ExecutionScope, operation: CheckRerun): Promise<OperationOutputsV1> {
  const result = await scope.api.restOptional(
    `${scope.repoPath}/check-runs/${encodeURIComponent(operation.checkRunId)}`,
    "Check run lookup",
  );
  if (result === null) throw conflict("check_run_missing", `Check run ${operation.checkRunId} no longer exists`);
  const check = result.data;
  if (!record(check) || typeof check.status !== "string" || typeof check.name !== "string") {
    throw failure("github_response_invalid", "Check run response was invalid");
  }
  if (check.head_sha !== operation.expectedHeadSha) {
    throw conflict("check_head_changed", `Precondition failed: check run head is ${String(check.head_sha)}`);
  }
  const appSlug = record(check.app) && typeof check.app.slug === "string" ? check.app.slug : null;
  if (appSlug === null || appSlug.toLowerCase() !== scope.actorAppSlug.toLowerCase()) {
    throw conflict(
      "check_not_owned",
      `Check run ${operation.checkRunId} was produced by ${appSlug ?? "an unknown app"}; `
        + `GITHUB_TOKEN can only re-request checks created by the ${scope.actorAppSlug} app`,
    );
  }

  // A restart that landed in place, or a newer run of the same name on the same
  // head, both prove a previous attempt already triggered the rerun.
  if (check.status !== "completed") {
    return { kind: operation.kind, checkRunId: operation.checkRunId, headSha: operation.expectedHeadSha, status: check.status };
  }
  // Reconciliation must prove a *newer* run exists. A sibling that is merely
  // in flight proves nothing: an unrelated run of the same name could have been
  // queued before this operation was ever planned, and treating it as evidence
  // would silently drop the rerun. An unparseable or missing `started_at`
  // likewise proves nothing, so both fail closed and the rerun is issued.
  const startedAt = typeof check.started_at === "string" ? Date.parse(check.started_at) : Number.NaN;
  const newer = Number.isFinite(startedAt)
    ? await scope.api.findPaginated(
      `${scope.repoPath}/commits/${encodeURIComponent(operation.expectedHeadSha)}/check-runs`
        + `?check_name=${encodeURIComponent(check.name)}`,
      "Check rerun reconciliation",
      (candidate) => {
        if (String(candidate.id) === operation.checkRunId) return false;
        const candidateStartedAt = typeof candidate.started_at === "string"
          ? Date.parse(candidate.started_at)
          : Number.NaN;
        return Number.isFinite(candidateStartedAt) && candidateStartedAt > startedAt;
      },
      "check_runs",
    )
    : null;
  if (newer) {
    return {
      kind: operation.kind,
      checkRunId: numericId(newer.id, "check run id"),
      headSha: operation.expectedHeadSha,
      status: typeof newer.status === "string" ? newer.status : "queued",
    };
  }

  if (check.status !== operation.expectedStatus) {
    throw conflict("check_status_changed", `Precondition failed: check run status is ${check.status}`);
  }
  const conclusion = check.conclusion === undefined || check.conclusion === null ? null : String(check.conclusion);
  if (conclusion !== operation.expectedConclusion) {
    throw conflict("check_conclusion_changed", `Precondition failed: check run conclusion is ${conclusion ?? "null"}`);
  }
  await scope.api.rest(
    `${scope.repoPath}/check-runs/${encodeURIComponent(operation.checkRunId)}/rerequest`,
    "Check run rerequest",
    { method: "POST" },
  );
  return { kind: operation.kind, checkRunId: operation.checkRunId, headSha: operation.expectedHeadSha, status: "queued" };
}

/* -------------------------------------------------------------------------- */
/* Release family                                                              */
/* -------------------------------------------------------------------------- */

const RELEASE_UPDATED_AT_QUERY = `query($id:ID!){ node(id:$id){ ... on Release { updatedAt } } }`;

/**
 * The REST release object has no `updated_at` field, so the contract's
 * `expectedReleaseUpdatedAt` precondition is resolved through GraphQL.
 */
async function releaseUpdatedAt(scope: ExecutionScope, nodeId: string): Promise<string> {
  const data = await scope.api.graphql(RELEASE_UPDATED_AT_QUERY, { id: nodeId }, "Release revision lookup");
  if (!record(data.node) || typeof data.node.updatedAt !== "string") {
    throw failure("github_response_invalid", "Release revision response was invalid");
  }
  return data.node.updatedAt;
}

function releaseOutputs(
  kind: "release.create" | "release.update" | "release.publish",
  release: JsonRecord,
): OperationOutputsV1 {
  if (typeof release.tag_name !== "string" || release.tag_name === "") {
    throw failure("github_response_invalid", "GitHub release response omitted its tag name");
  }
  return {
    kind,
    releaseId: numericId(release.id, "release id"),
    tagName: release.tag_name,
    releaseUrl: htmlUrl(release),
    draft: release.draft === true,
    prerelease: release.prerelease === true,
  };
}

/**
 * Resolves the commit a release actually points at.
 *
 * `target_commitish` is not a SHA in general: GitHub stores whatever was
 * supplied, so human-created releases usually carry a branch name such as
 * `main`, and published releases keep the branch name even though the tag is
 * now fixed. Comparing that raw field against the contract's 40-hex
 * `expectedTargetCommitSha` would conflict on every such release, so the field
 * is dereferenced to a commit SHA first.
 */
async function resolveReleaseTargetSha(scope: ExecutionScope, release: JsonRecord): Promise<string> {
  const target = typeof release.target_commitish === "string" ? release.target_commitish : "";
  if (GIT_SHA.test(target)) return target.toLowerCase();
  const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
  // A published release has a real tag; a draft has only its target branch.
  if (release.draft === false && tagName !== "") {
    const tagged = await resolveTagCommit(scope, tagName);
    if (tagged !== null) return tagged;
  }
  if (target === "") {
    throw conflict("release_target_unresolved", "Release does not record a target commit");
  }
  const head = await loadRef(scope, `heads/${encodeRefPath(target)}`);
  if (head === null) {
    throw conflict("release_target_unresolved", `Release target ${target} could not be resolved to a commit`);
  }
  return head.toLowerCase();
}

/** Dereferences a tag ref, following annotated tag objects to their commit. */
async function resolveTagCommit(scope: ExecutionScope, tagName: string): Promise<string | null> {
  const result = await scope.api.restOptional(
    `${scope.repoPath}/git/ref/tags/${encodeRefPath(tagName)}`,
    "Release tag lookup",
  );
  if (result === null) return null;
  const { data } = result;
  if (!record(data) || !record(data.object) || typeof data.object.sha !== "string") {
    throw failure("github_response_invalid", "Tag reference response was invalid");
  }
  if (data.object.type !== "tag") return data.object.sha.toLowerCase();
  const { data: annotated } = await scope.api.rest(
    `${scope.repoPath}/git/tags/${encodeURIComponent(data.object.sha)}`,
    "Annotated tag lookup",
  );
  if (!record(annotated) || !record(annotated.object) || typeof annotated.object.sha !== "string") {
    throw failure("github_response_invalid", "Annotated tag response was invalid");
  }
  return annotated.object.sha.toLowerCase();
}

type ReleaseCreate = Extract<Operation, { kind: "release.create" }>;

async function executeReleaseCreate(scope: ExecutionScope, operation: ReleaseCreate): Promise<OperationOutputsV1> {
  // Draft releases never create their Git tag, so the tag ref stays absent
  // across retries and the draft list is the correct idempotency source.
  const existing = await scope.api.findPaginated(
    `${scope.repoPath}/releases`,
    "Release idempotency lookup",
    (candidate) => candidate.tag_name === operation.tagName,
  );
  if (existing) {
    const targetSha = await resolveReleaseTargetSha(scope, existing);
    const matches = existing.draft === true
      && existing.name === operation.name
      && existing.body === operation.body
      && existing.prerelease === operation.prerelease
      && targetSha === operation.targetCommitSha.toLowerCase();
    if (!matches) throw conflict("release_exists", `A different release already uses tag ${operation.tagName}`);
    return releaseOutputs(operation.kind, existing);
  }
  const tagRef = await loadRef(scope, `tags/${encodeRefPath(operation.tagName)}`);
  if (tagRef !== null) throw conflict("tag_exists", `Precondition failed: tag ${operation.tagName} already exists`);
  const { data } = await scope.api.rest(`${scope.repoPath}/releases`, "Release creation", {
    method: "POST",
    body: JSON.stringify({
      tag_name: operation.tagName,
      target_commitish: operation.targetCommitSha,
      name: operation.name,
      body: operation.body,
      draft: operation.draft,
      prerelease: operation.prerelease,
    }),
  });
  if (!record(data)) throw failure("github_response_invalid", "Release creation response was invalid");
  return releaseOutputs(operation.kind, data);
}

type ReleaseMutation = Extract<Operation, { kind: "release.update" | "release.publish" | "release.delete" }>;

async function loadRelease(scope: ExecutionScope, releaseId: string): Promise<JsonRecord | null> {
  const result = await scope.api.restOptional(
    `${scope.repoPath}/releases/${encodeURIComponent(releaseId)}`,
    "Release lookup",
  );
  if (result === null) return null;
  if (!record(result.data)) throw failure("github_response_invalid", "Release response was invalid");
  return result.data;
}

async function assertReleaseIdentity(
  scope: ExecutionScope,
  release: JsonRecord,
  operation: ReleaseMutation,
): Promise<void> {
  if (release.tag_name !== operation.expectedTagName) {
    throw conflict("release_tag_changed", `Precondition failed: release tag is ${String(release.tag_name)}`);
  }
  const targetSha = await resolveReleaseTargetSha(scope, release);
  if (targetSha !== operation.expectedTargetCommitSha.toLowerCase()) {
    throw conflict("release_target_changed", `Precondition failed: release target resolves to ${targetSha}`);
  }
}

async function assertReleaseRevision(scope: ExecutionScope, release: JsonRecord, expectedUpdatedAt: string): Promise<void> {
  if (typeof release.node_id !== "string") throw failure("github_response_invalid", "Release node id was missing");
  const updatedAt = await releaseUpdatedAt(scope, release.node_id);
  if (!sameInstant(updatedAt, expectedUpdatedAt)) {
    throw conflict("release_changed", "Precondition failed: release changed after the operation was planned");
  }
}

type ReleaseUpdate = Extract<Operation, { kind: "release.update" }>;

async function executeReleaseUpdate(scope: ExecutionScope, operation: ReleaseUpdate): Promise<OperationOutputsV1> {
  const release = await loadRelease(scope, operation.releaseId);
  if (release === null) throw conflict("release_missing", `Release ${operation.releaseId} no longer exists`);
  await assertReleaseIdentity(scope, release, operation);
  const settled = (operation.name === undefined || release.name === operation.name)
    && (operation.body === undefined || release.body === operation.body)
    && (operation.prerelease === undefined || release.prerelease === operation.prerelease);
  if (settled) return releaseOutputs(operation.kind, release);
  if (release.draft !== operation.expectedDraft) {
    throw conflict("release_draft_changed", "Precondition failed: release draft state changed");
  }
  if (release.prerelease !== operation.expectedPrerelease && operation.prerelease === undefined) {
    throw conflict("release_prerelease_changed", "Precondition failed: release prerelease state changed");
  }
  await assertReleaseRevision(scope, release, operation.expectedReleaseUpdatedAt);
  const patch: Record<string, unknown> = {};
  if (operation.name !== undefined) patch.name = operation.name;
  if (operation.body !== undefined) patch.body = operation.body;
  if (operation.prerelease !== undefined) patch.prerelease = operation.prerelease;
  const { data } = await scope.api.rest(
    `${scope.repoPath}/releases/${encodeURIComponent(operation.releaseId)}`,
    "Release update",
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  if (!record(data)) throw failure("github_response_invalid", "Release update response was invalid");
  const applied = (operation.name === undefined || data.name === operation.name)
    && (operation.body === undefined || data.body === operation.body)
    && (operation.prerelease === undefined || data.prerelease === operation.prerelease);
  if (!applied) throw conflict("release_update_not_applied", "GitHub did not apply the exact release update");
  return releaseOutputs(operation.kind, data);
}

type ReleasePublish = Extract<Operation, { kind: "release.publish" }>;

async function executeReleasePublish(scope: ExecutionScope, operation: ReleasePublish): Promise<OperationOutputsV1> {
  const release = await loadRelease(scope, operation.releaseId);
  if (release === null) throw conflict("release_missing", `Release ${operation.releaseId} no longer exists`);
  await assertReleaseIdentity(scope, release, operation);
  if (release.draft === false) return releaseOutputs(operation.kind, release);
  if (release.prerelease !== operation.expectedPrerelease) {
    throw conflict("release_prerelease_changed", "Precondition failed: release prerelease state changed");
  }
  await assertReleaseRevision(scope, release, operation.expectedReleaseUpdatedAt);
  const { data } = await scope.api.rest(
    `${scope.repoPath}/releases/${encodeURIComponent(operation.releaseId)}`,
    "Release publish",
    { method: "PATCH", body: JSON.stringify({ draft: false }) },
  );
  if (!record(data) || data.draft !== false) {
    throw conflict("release_publish_not_applied", "GitHub did not publish the release");
  }
  return releaseOutputs(operation.kind, data);
}

type ReleaseDelete = Extract<Operation, { kind: "release.delete" }>;

async function executeReleaseDelete(scope: ExecutionScope, operation: ReleaseDelete): Promise<OperationOutputsV1> {
  const release = await loadRelease(scope, operation.releaseId);
  if (release === null) {
    return { kind: operation.kind, releaseId: operation.releaseId, tagName: operation.expectedTagName };
  }
  await assertReleaseIdentity(scope, release, operation);
  if (release.draft !== operation.expectedDraft) {
    throw conflict("release_draft_changed", "Precondition failed: release draft state changed");
  }
  const published = release.draft === false;
  if (published !== operation.expectedPublished) {
    throw conflict("release_published_changed", "Precondition failed: release published state changed");
  }
  await assertReleaseRevision(scope, release, operation.expectedReleaseUpdatedAt);
  await scope.api.rest(
    `${scope.repoPath}/releases/${encodeURIComponent(operation.releaseId)}`,
    "Release deletion",
    { method: "DELETE" },
  );
  return { kind: operation.kind, releaseId: operation.releaseId, tagName: operation.expectedTagName };
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

async function dispatch(scope: ExecutionScope, operation: Operation): Promise<OperationOutputsV1> {
  switch (operation.kind) {
    case "issue.label.add":
    case "issue.label.remove":
      return executeLabel(scope, operation);
    case "issue.comment.create":
      return executeIssueCommentCreate(scope, operation);
    case "issue.comment.update": {
      const result = await executeCommentUpdate(scope, operation, operation.issueNumber, async () => {
        const issue = await loadIssue(scope, operation.issueNumber, false);
        assertIssueState(scope, issue, operation.expectedIssueState, operation.expectedIssueUpdatedAt);
      });
      return { kind: operation.kind, issueNumber: operation.issueNumber, ...result };
    }
    case "issue.close":
    case "issue.reopen":
      return executeIssueState(scope, operation);
    case "issue.assignee.add":
    case "issue.assignee.remove":
      return executeAssignee(scope, operation);
    case "pull_request.comment.create":
      return executePullCommentCreate(scope, operation);
    case "pull_request.comment.update":
      return executePullCommentUpdate(scope, operation);
    case "pull_request.review.submit":
      return executeReviewSubmit(scope, operation);
    case "pull_request.reviewer.request":
    case "pull_request.reviewer.remove":
      return executeReviewer(scope, operation);
    case "pull_request.update":
      return executePullUpdate(scope, operation);
    case "branch.create":
      return executeBranchCreate(scope, operation);
    case "commit.create":
      return executeCommitCreate(scope, operation);
    case "pull_request.open_draft":
      return executePullOpenDraft(scope, operation);
    case "pull_request.merge":
      return executePullMerge(scope, operation);
    case "discussion.comment.create":
      return executeDiscussionCommentCreate(scope, operation);
    case "discussion.comment.update":
      return executeDiscussionCommentUpdate(scope, operation);
    case "discussion.answer.mark":
    case "discussion.answer.unmark":
      return executeDiscussionAnswer(scope, operation);
    case "discussion.close":
    case "discussion.reopen":
      return executeDiscussionState(scope, operation);
    case "check.rerun":
      return executeCheckRerun(scope, operation);
    case "release.create":
      return executeReleaseCreate(scope, operation);
    case "release.update":
      return executeReleaseUpdate(scope, operation);
    case "release.publish":
      return executeReleasePublish(scope, operation);
    case "release.delete":
      return executeReleaseDelete(scope, operation);
  }
}

/**
 * Re-exported from the provider adapter, which is the single source of truth
 * shared with the CLI compiler. Keeping one map means the permissions the
 * generated workflow grants and the permissions this executor actually needs
 * cannot drift apart.
 */
export { OPERATION_TOKEN_PERMISSIONS } from "@gardener/provider-github";

function assertContext(context: GitHubEffectsContext, operation: Operation, operationHash: string): ExecutionScope {
  if (!context.token) throw new Error("A GitHub token is required to apply effects");
  if (!REPOSITORY_FULL_NAME.test(context.repositoryFullName)) {
    throw new Error("repositoryFullName must be an owner/name GitHub repository");
  }
  // The executor derives the hash itself. A supplied hash is a cross-check, not
  // an input: accepting a caller's drifted value would write commit trailers and
  // receipts that no later attempt could reconcile against.
  if (context.operationHash !== undefined && context.operationHash !== operationHash) {
    throw new Error(
      `operationHash ${context.operationHash} does not match the canonical hash ${operationHash} for operation ${operation.id}`,
    );
  }
  if (!Number.isSafeInteger(context.attempt) || context.attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  const [owner, name] = context.repositoryFullName.split("/") as [string, string];
  if (operation.repository.owner !== owner || operation.repository.name !== name) {
    throw new Error(
      `Operation targets ${operation.repository.owner}/${operation.repository.name}, not the bound repository ${context.repositoryFullName}`,
    );
  }
  const deadline = (context.now ?? (() => new Date()))().getTime() + (context.budgetMs ?? DEFAULT_BUDGET_MS);
  return {
    api: new GitHubApi(context, deadline),
    repoPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    owner,
    name,
    actorLogin: context.actorLogin ?? DEFAULT_ACTOR_LOGIN,
    actorAppSlug: context.actorAppSlug ?? DEFAULT_ACTOR_APP_SLUG,
    operationHash,
    ...(context.readCapturedFile === undefined ? {} : { readCapturedFile: context.readCapturedFile }),
    ...(context.chainedResourceVersion === undefined ? {} : { chainedResourceVersion: context.chainedResourceVersion }),
    versionVerified: false,
  };
}

/**
 * Applies one canonical operation and always returns a receipt.
 *
 * Status semantics:
 * - `succeeded`  — the mutation was applied by this attempt;
 * - `skipped`    — reconciliation proved the exact effect already exists;
 * - `conflicted` — a precondition no longer holds, so this exact operation can
 *                  never succeed and the plan must stop;
 * - `failed`     — transport or GitHub-side failure; `error.retryable` states
 *                  whether the same attempt may be repeated.
 *
 * Only malformed executor inputs throw, because those are caller defects rather
 * than operation outcomes.
 */
export async function executeActionsOperation(
  operationInput: Operation,
  context: GitHubEffectsContext,
): Promise<GitHubEffectResult> {
  const operation = operationSchema.parse(operationInput);
  const operationHash = canonicalOperationHash(operation);
  const scope = assertContext(context, operation, operationHash);
  const clock = context.now ?? (() => new Date());
  const attemptedAt = clock().toISOString();

  const base = {
    schemaVersion: "v2" as const,
    operationId: operation.id,
    operationHash,
    kind: operation.kind,
    attempt: context.attempt,
    attemptedAt,
  };

  try {
    const outputs = await dispatch(scope, operation);
    const receipt = operationReceiptSchema.parse({
      ...base,
      // A mutating request during this attempt means the effect was applied now;
      // a read-only path means reconciliation proved it already existed.
      status: scope.api.mutated ? "succeeded" : "skipped",
      completedAt: latest(attemptedAt, clock().toISOString()),
      ...requestId(scope),
      ...resourceUrl(outputs),
    });
    // Only a write this attempt made after verifying the resource's version may
    // extend the chain. A reconciled (skipped) step, or a write on a path that
    // never checked the version, would otherwise let the read-back adopt edits
    // made by others since planning.
    const version = context.readBackVersion === true && scope.api.mutated && scope.versionVerified
      ? await readResourceVersion(scope, operation)
      : null;
    return { receipt, outputs, ...(version ? { resourceVersion: version } : {}) };
  } catch (error) {
    const effect = error instanceof GitHubEffectError
      ? error
      : failure("effect_failed", error instanceof Error ? error.message : "GitHub effect failed");
    const receipt = operationReceiptSchema.parse({
      ...base,
      status: effect.classification,
      completedAt: latest(attemptedAt, clock().toISOString()),
      ...(effect.providerRequestId ? { providerRequestId: effect.providerRequestId } : requestId(scope)),
      error: {
        code: effect.code,
        message: effect.message.slice(0, 2_000),
        retryable: effect.retryable,
      },
    });
    return { receipt };
  }
}

/**
 * Issue, pull request, or discussion whose `updated_at` this operation's
 * precondition checks, or null when it checks none.
 */
export function resourceVersionKey(operation: Operation): string | null {
  if ("issueNumber" in operation) return `issue:${operation.issueNumber}`;
  if ("pullNumber" in operation) return `pull:${operation.pullNumber}`;
  if ("discussionNumber" in operation) return `discussion:${operation.discussionNumber}`;
  return null;
}

/**
 * Reads the version a successful step left its resource at.
 *
 * GitHub's write responses describe the comment, label, or review created,
 * not the parent resource, so the parent is read back, retrying so a transient
 * error does not become a terminal conflict. A read-back that still fails
 * leaves the version unknown; a later step on the same resource then fails its
 * precondition rather than trusting a guess.
 */
async function readResourceVersion(scope: ExecutionScope, operation: Operation): Promise<ResourceVersion | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = await readResourceVersionOnce(scope, operation);
    if (version !== null) return version;
  }
  return null;
}

async function readResourceVersionOnce(scope: ExecutionScope, operation: Operation): Promise<ResourceVersion | null> {
  const resource = resourceVersionKey(operation);
  if (resource === null) return null;
  try {
    let updatedAt: unknown;
    if ("issueNumber" in operation) {
      ({ data: { updated_at: updatedAt } } = await scope.api.rest(`${scope.repoPath}/issues/${operation.issueNumber}`, "Issue version read-back") as { data: JsonRecord });
    } else if ("pullNumber" in operation) {
      ({ data: { updated_at: updatedAt } } = await scope.api.rest(`${scope.repoPath}/pulls/${operation.pullNumber}`, "Pull request version read-back") as { data: JsonRecord });
    } else if ("discussionNumber" in operation) {
      updatedAt = (await loadDiscussion(scope, operation.discussionNumber)).updatedAt;
    }
    return typeof updatedAt === "string" && ISO_INSTANT.test(updatedAt) ? { resource, updatedAt } : null;
  } catch {
    return null;
  }
}

function requestId(scope: ExecutionScope): { providerRequestId?: string } {
  const value = scope.api.lastRequestId;
  return value ? { providerRequestId: value } : {};
}

function resourceUrl(outputs: OperationOutputsV1): { resourceUrl?: string } {
  const candidate = "commentUrl" in outputs
    ? outputs.commentUrl
    : "pullUrl" in outputs
      ? outputs.pullUrl
      : "issueUrl" in outputs
        ? outputs.issueUrl
        : "commitUrl" in outputs
          ? outputs.commitUrl
          : "branchUrl" in outputs
            ? outputs.branchUrl
            : "releaseUrl" in outputs
              ? outputs.releaseUrl
              : "reviewUrl" in outputs
                ? outputs.reviewUrl
                : "discussionUrl" in outputs
                  ? outputs.discussionUrl
                  : undefined;
  return candidate && candidate.startsWith("https://") ? { resourceUrl: candidate } : {};
}

function latest(attemptedAt: string, completedAt: string): string {
  return Date.parse(completedAt) < Date.parse(attemptedAt) ? attemptedAt : completedAt;
}
