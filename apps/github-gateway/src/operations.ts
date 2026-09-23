import {
  availableGitHubOperationKinds,
  executeGitHubOperationRequestSchema,
  executeGitHubOperationResultSchema,
  type ExecuteGitHubOperationRequest,
  type ExecuteGitHubOperationResult,
  type Operation,
  type OperationReceipt,
  type RepositoryEventV2,
} from "@gardener/provider-github";
import { canonicalOperationHash } from "@gardener/core";
import { isInstallationBackedRepository, operationReceiptSchema, repositoryEventV2Schema } from "@gardener/contracts";
import { canonicalSha256, nowSeconds, randomToken } from "./database";
import type { Env } from "./env";
import { executeGitHubOperation, GitHubOperationError } from "./github-client";

const EXECUTION_LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 20;
const availableOperations = new Set<string>(availableGitHubOperationKinds);

interface ReceiptRow {
  operation_hash: string;
  operation_kind: string;
  operation_json: string;
  run_id: string;
  event_id: string;
  repository_id: string;
  installation_id: string;
  resource_number: number | null;
  status: string;
  attempt_count: number;
  lease_expires_at: number | null;
  receipt_json: string | null;
  receipt_hash: string | null;
}

export async function executeBoundedOperation(
  env: Env,
  inputValue: ExecuteGitHubOperationRequest,
): Promise<ExecuteGitHubOperationResult> {
  const input = executeGitHubOperationRequestSchema.parse(inputValue);
  const operation = input.operation;
  if (!availableOperations.has(operation.kind)) {
    throw new GitHubOperationError(
      "unsupported_operation",
      `GitHub Gateway does not implement verified execution for ${operation.kind}`,
    );
  }
  // An operation's installation identity is optional in the contract because an
  // Actions-planned operation genuinely has none. This gateway mints
  // installation tokens and binds `installation_id` into the lease and receipt
  // rows, so it refuses such an operation up front rather than binding
  // `undefined` into those queries further down.
  if (!isInstallationBackedRepository(operation.repository)) {
    throw new GitHubOperationError(
      "installation_required",
      "GitHub Gateway requires an installation-bound operation",
    );
  }
  const installationId = operation.repository.installationId;

  const eventRow = await env.DB.prepare(
    "SELECT normalized_event_json, normalized_event_hash FROM webhook_deliveries " +
    "WHERE normalized_event_id = ? AND status = 'delivered'",
  ).bind(input.eventId).first<{
    normalized_event_json: string;
    normalized_event_hash: string;
  }>();
  if (!eventRow) throw new GitHubOperationError("event_not_delivered", "Operation event was not delivered");

  const event = repositoryEventV2Schema.parse(JSON.parse(eventRow.normalized_event_json));
  if (await canonicalSha256(event) !== eventRow.normalized_event_hash) {
    throw new GitHubOperationError("event_integrity_failed", "Stored event integrity check failed");
  }
  assertOperationMatchesEvent(operation, event);

  const repository = await env.DB.prepare(
    "SELECT r.id FROM repositories r JOIN installations i ON i.id = r.installation_id " +
    "WHERE r.id = ? AND r.installation_id = ? AND r.owner = ? AND r.name = ? " +
    "AND r.active = 1 AND i.suspended_at IS NULL AND i.revoked_at IS NULL",
  ).bind(
    operation.repository.id,
    installationId,
    operation.repository.owner,
    operation.repository.name,
  ).first();
  if (!repository) throw new GitHubOperationError("repository_not_active", "Repository is not active");

  const operationHash = await canonicalOperationHash(operation);
  const operationJson = JSON.stringify(operation);
  const resourceNumber = eventResourceNumber(event);
  const existing = await readReceipt(env.DB, operation.id);
  if (existing) assertSameOperation(existing, input, operation, operationHash, operationJson, resourceNumber);
  if (existing?.receipt_json && ["succeeded", "skipped", "conflicted"].includes(existing.status)) {
    const receipt = await verifiedReceipt(existing);
    return executeGitHubOperationResultSchema.parse({ receipt });
  }
  if (existing?.receipt_json && existing.status === "failed") {
    const prior = await verifiedReceipt(existing);
    if (prior.error?.retryable === false) return { receipt: prior };
  }

  const now = nowSeconds();
  if (existing?.status === "executing" && (existing.lease_expires_at ?? Number.POSITIVE_INFINITY) > now) {
    throw new GitHubOperationError("operation_in_progress", "Operation is already executing", true);
  }
  const attemptToken = randomToken("attempt_");
  const attempt = (existing?.attempt_count ?? 0) + 1;
  if (attempt > MAX_ATTEMPTS) {
    throw new GitHubOperationError("operation_attempts_exhausted", "Operation retry budget is exhausted");
  }

  if (!existing) {
    const created = await env.DB.prepare(
      "INSERT INTO operation_receipts " +
      "(operation_id, operation_hash, operation_kind, operation_json, run_id, event_id, " +
      "repository_id, installation_id, resource_number, status, attempt_count, attempt_token, lease_expires_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'executing', 1, ?, ?) " +
      "ON CONFLICT(operation_id) DO NOTHING",
    ).bind(
      operation.id,
      operationHash,
      operation.kind,
      operationJson,
      input.runId,
      input.eventId,
      operation.repository.id,
      installationId,
      resourceNumber,
      attemptToken,
      now + EXECUTION_LEASE_SECONDS,
    ).run();
    if ((created.meta.changes ?? 0) !== 1) {
      const winner = await readReceipt(env.DB, operation.id);
      if (winner) assertSameOperation(winner, input, operation, operationHash, operationJson, resourceNumber);
      throw new GitHubOperationError("operation_claim_conflict", "Operation execution was claimed", true);
    }
  } else {
    const claimed = await env.DB.prepare(
      "UPDATE operation_receipts SET status = 'executing', attempt_count = attempt_count + 1, " +
      "attempt_token = ?, lease_expires_at = ?, receipt_json = NULL, receipt_hash = NULL, " +
      "last_error = NULL, completed_at = NULL WHERE operation_id = ? AND attempt_count < ? " +
      "AND (status = 'failed' OR (status = 'executing' AND lease_expires_at <= ?))",
    ).bind(
      attemptToken,
      now + EXECUTION_LEASE_SECONDS,
      operation.id,
      MAX_ATTEMPTS,
      now,
    ).run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      throw new GitHubOperationError("operation_claim_conflict", "Operation retry was claimed", true);
    }
  }

  const attemptedAt = new Date().toISOString();
  try {
    const result = await executeGitHubOperation(env, operation);
    const receipt = operationReceiptSchema.parse({
      schemaVersion: "v2",
      operationId: operation.id,
      operationHash,
      kind: operation.kind,
      status: result.status === "already-applied" ? "skipped" : "succeeded",
      attempt,
      attemptedAt,
      completedAt: new Date().toISOString(),
      ...(result.providerRequestId ? { providerRequestId: result.providerRequestId } : {}),
      ...(result.url ? { resourceUrl: result.url } : {}),
    });
    await completeReceipt(env.DB, operation.id, attemptToken, receipt);
    return executeGitHubOperationResultSchema.parse({ receipt });
  } catch (error) {
    const typed = operationError(error);
    const receipt = operationReceiptSchema.parse({
      schemaVersion: "v2",
      operationId: operation.id,
      operationHash,
      kind: operation.kind,
      status: typed.code === "branch_protection_changed" ? "conflicted" : "failed",
      attempt,
      attemptedAt,
      completedAt: new Date().toISOString(),
      error: {
        code: typed.code,
        message: safeError(typed),
        retryable: typed.retryable,
      },
    });
    await failReceipt(env.DB, operation.id, attemptToken, receipt);
    return executeGitHubOperationResultSchema.parse({ receipt });
  }
}

function assertOperationMatchesEvent(operation: Operation, event: RepositoryEventV2): void {
  if (
    operation.repository.id !== event.repository.id ||
    operation.repository.installationId !== event.repository.installationId ||
    operation.repository.owner !== event.repository.owner ||
    operation.repository.name !== event.repository.name
  ) {
    throw new GitHubOperationError("event_repository_mismatch", "Operation repository does not match its event");
  }

  if ("issueNumber" in operation) {
    const issue = event.kind === "github.issue" || event.kind === "github.issue_comment"
      ? event.issue
      : null;
    if (
      !issue ||
      operation.issueNumber !== issue.number ||
      operation.expectedIssueState !== issue.state ||
      operation.expectedIssueUpdatedAt !== issue.updatedAt
    ) {
      throw new GitHubOperationError("event_resource_mismatch", "Issue operation does not match its event");
    }
    if (operation.kind === "issue.comment.update") {
      if (
        event.kind !== "github.issue_comment" ||
        operation.commentId !== event.comment.id ||
        operation.expectedCommentUpdatedAt !== event.comment.updatedAt
      ) {
        throw new GitHubOperationError(
          "event_resource_mismatch",
          "Comment update requires the exact comment event",
        );
      }
    }
    return;
  }

  if ("pullNumber" in operation) {
    if (![
      "github.pull_request",
      "github.pull_request_comment",
      "github.pull_request_review",
      "github.pull_request_review_comment",
    ].includes(event.kind)) {
      throw new GitHubOperationError("event_resource_mismatch", "Pull request operation requires a pull request event");
    }
    const pull = "pullRequest" in event ? event.pullRequest : null;
    if (
      !pull ||
      operation.pullNumber !== pull.number ||
      operation.expectedHeadSha !== pull.head.sha ||
      operation.expectedBaseRef !== pull.base.ref ||
      operation.expectedBaseSha !== pull.base.sha ||
      operation.expectedState !== pull.state ||
      operation.expectedDraft !== pull.draft ||
      operation.expectedPullUpdatedAt !== pull.updatedAt
    ) {
      throw new GitHubOperationError("event_resource_mismatch", "Pull request operation does not match its event");
    }
    return;
  }

  // The verified branch, commit, and draft-PR executors are intentionally issue-triggered.
  if (event.kind !== "github.issue" && event.kind !== "github.issue_comment") {
    throw new GitHubOperationError("event_resource_mismatch", "Operation requires an issue event");
  }
}

function eventResourceNumber(event: RepositoryEventV2): number | null {
  if ("issue" in event) return event.issue.number;
  if ("pullRequest" in event) return event.pullRequest.number;
  if ("discussion" in event) return event.discussion.number;
  if ("checkRun" in event) return Number(event.checkRun.id);
  if ("release" in event) return Number(event.release.id);
  return null;
}

function assertSameOperation(
  existing: ReceiptRow,
  input: ExecuteGitHubOperationRequest,
  operation: Operation,
  operationHash: string,
  operationJson: string,
  resourceNumber: number | null,
): void {
  if (
    existing.operation_hash !== operationHash ||
    existing.operation_kind !== operation.kind ||
    existing.operation_json !== operationJson ||
    existing.run_id !== input.runId ||
    existing.event_id !== input.eventId ||
    existing.repository_id !== operation.repository.id ||
    existing.installation_id !== operation.repository.installationId ||
    existing.resource_number !== resourceNumber
  ) {
    throw new GitHubOperationError(
      "operation_id_conflict",
      "Operation id was already used for a different operation",
    );
  }
}

async function readReceipt(db: D1Database, operationId: string): Promise<ReceiptRow | null> {
  return db.prepare(
    "SELECT operation_hash, operation_kind, operation_json, run_id, event_id, repository_id, " +
    "installation_id, resource_number, status, attempt_count, lease_expires_at, receipt_json, " +
    "receipt_hash " +
    "FROM operation_receipts WHERE operation_id = ?",
  ).bind(operationId).first<ReceiptRow>();
}

async function verifiedReceipt(row: ReceiptRow): Promise<OperationReceipt> {
  if (!row.receipt_json || !row.receipt_hash) {
    throw new GitHubOperationError("receipt_integrity_failed", "Stored operation receipt is incomplete");
  }
  const receipt = operationReceiptSchema.parse(JSON.parse(row.receipt_json));
  if (await canonicalSha256(receipt) !== row.receipt_hash) {
    throw new GitHubOperationError("receipt_integrity_failed", "Stored operation receipt integrity check failed");
  }
  return receipt;
}

async function completeReceipt(
  db: D1Database,
  operationId: string,
  attemptToken: string,
  receipt: OperationReceipt,
): Promise<void> {
  const receiptJson = JSON.stringify(receipt);
  const updated = await db.prepare(
    "UPDATE operation_receipts SET status = ?, receipt_json = ?, receipt_hash = ?, " +
    "attempt_token = NULL, lease_expires_at = NULL, completed_at = CURRENT_TIMESTAMP " +
    "WHERE operation_id = ? AND attempt_token = ?",
  ).bind(
    receipt.status,
    receiptJson,
    await canonicalSha256(receipt),
    operationId,
    attemptToken,
  ).run();
  if ((updated.meta.changes ?? 0) !== 1) {
    throw new GitHubOperationError("operation_lease_lost", "Operation execution lease was lost", true);
  }
}

async function failReceipt(
  db: D1Database,
  operationId: string,
  attemptToken: string,
  receipt: OperationReceipt,
): Promise<void> {
  const receiptJson = JSON.stringify(receipt);
  const updated = await db.prepare(
    "UPDATE operation_receipts SET status = ?, receipt_json = ?, receipt_hash = ?, " +
    "last_error = ?, attempt_token = NULL, lease_expires_at = NULL, completed_at = CURRENT_TIMESTAMP " +
    "WHERE operation_id = ? AND attempt_token = ?",
  ).bind(
    receipt.status,
    receiptJson,
    await canonicalSha256(receipt),
    receipt.error?.message ?? "Operation failed",
    operationId,
    attemptToken,
  ).run();
  if ((updated.meta.changes ?? 0) !== 1) {
    throw new GitHubOperationError("operation_lease_lost", "Operation execution lease was lost", true);
  }
}

function operationError(error: unknown): GitHubOperationError {
  if (error instanceof GitHubOperationError) return error;
  return new GitHubOperationError(
    "github_execution_failed",
    error instanceof Error ? error.message : "GitHub operation failed",
    error instanceof TypeError,
  );
}

function safeError(error: Error): string {
  return /^[A-Za-z0-9 ._():,'/-]{1,500}$/.test(error.message)
    ? error.message
    : "GitHub operation failed";
}
