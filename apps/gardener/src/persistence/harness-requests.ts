import { canonicalSha256 } from "@gardener/core";
import {
  assertHarnessRequest,
  assertHarnessSubmission,
  expectedHarnessBinding,
  type HarnessRequest,
  type HarnessSubmission,
  type HarnessSubmissionStore,
} from "../harness";

interface HarnessRequestRow {
  run_id: string;
  request_id: string;
  harness_id: string;
  harness_version: string;
  request_json: string;
  request_hash: string;
}

interface HarnessSubmissionRow {
  run_id: string;
  request_id: string;
  submission_id: string;
  harness_id: string;
  harness_version: string;
  submission_json: string;
  submission_hash: string;
}

interface RunHarnessRow {
  harness_id: string;
  harness_version: string;
}

/** D1-backed immutable request and dispatch-receipt storage for Flue. */
export class D1HarnessRequestStore implements HarnessSubmissionStore {
  constructor(private readonly db: D1Database) {}

  async put(request: HarnessRequest): Promise<void> {
    assertHarnessRequest(request, expectedHarnessBinding("flue"));
    await this.assertRunBinding(request.runId, request.snapshot.harness.id, request.snapshot.harness.adapterVersion);
    const requestHash = await canonicalSha256(request);
    await this.db.prepare(`
      INSERT OR IGNORE INTO harness_requests
        (run_id, request_id, harness_id, harness_version, request_json, request_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      request.runId,
      request.requestId,
      request.snapshot.harness.id,
      request.snapshot.harness.adapterVersion,
      JSON.stringify(request),
      requestHash,
    ).run();

    const row = await this.requestRow(request.runId, request.requestId);
    if (
      !row
      || row.request_hash !== requestHash
      || row.harness_id !== request.snapshot.harness.id
      || row.harness_version !== request.snapshot.harness.adapterVersion
    ) throw new Error(`Immutable harness request conflict for ${request.requestId}`);
  }

  async get(runId: string, requestId: string): Promise<HarnessRequest | null> {
    const row = await this.requestRow(runId, requestId);
    if (!row) return null;
    const request: unknown = JSON.parse(row.request_json);
    assertHarnessRequest(request, { id: "flue", adapterVersion: row.harness_version });
    if (
      request.runId !== runId
      || request.requestId !== requestId
      || request.snapshot.harness.id !== row.harness_id
      || request.snapshot.harness.adapterVersion !== row.harness_version
      || await canonicalSha256(request) !== row.request_hash
    ) throw new Error(`Harness request integrity validation failed for ${requestId}`);
    await this.assertRunBinding(runId, row.harness_id, row.harness_version);
    return request;
  }

  async putSubmission(submission: HarnessSubmission): Promise<void> {
    assertHarnessSubmission(submission, expectedHarnessBinding("flue"));
    const request = await this.requestRow(submission.runId, submission.requestId);
    if (
      !request
      || request.harness_id !== submission.harness.id
      || request.harness_version !== submission.harness.adapterVersion
    ) throw new Error(`Missing matching immutable harness request for submission ${submission.submissionId}`);
    await this.assertRunBinding(submission.runId, submission.harness.id, submission.harness.adapterVersion);
    const submissionHash = await canonicalSha256(submission);
    await this.db.prepare(`
      INSERT OR IGNORE INTO harness_submissions
        (run_id, request_id, submission_id, harness_id, harness_version, submission_json, submission_hash, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      submission.runId,
      submission.requestId,
      submission.submissionId,
      submission.harness.id,
      submission.harness.adapterVersion,
      JSON.stringify(submission),
      submissionHash,
      submission.acceptedAt,
    ).run();

    const row = await this.submissionRow(submission.runId, submission.requestId);
    if (
      !row
      || row.submission_id !== submission.submissionId
      || row.submission_hash !== submissionHash
      || row.harness_id !== submission.harness.id
      || row.harness_version !== submission.harness.adapterVersion
    ) throw new Error(`Immutable harness submission conflict for ${submission.requestId}`);
  }

  async getSubmission(runId: string, requestId: string): Promise<HarnessSubmission | null> {
    const row = await this.submissionRow(runId, requestId);
    if (!row) return null;
    const submission: unknown = JSON.parse(row.submission_json);
    assertHarnessSubmission(submission, { id: "flue", adapterVersion: row.harness_version });
    if (
      submission.runId !== runId
      || submission.requestId !== requestId
      || submission.submissionId !== row.submission_id
      || submission.harness.id !== row.harness_id
      || submission.harness.adapterVersion !== row.harness_version
      || await canonicalSha256(submission) !== row.submission_hash
    ) throw new Error(`Harness submission integrity validation failed for ${requestId}`);
    await this.assertRunBinding(runId, row.harness_id, row.harness_version);
    return submission;
  }

  private async assertRunBinding(runId: string, harnessId: string, harnessVersion: string): Promise<void> {
    const run = await this.db.prepare("SELECT harness_id, harness_version FROM agent_runs WHERE id = ?")
      .bind(runId).first<RunHarnessRow>();
    if (!run || run.harness_id !== harnessId || run.harness_version !== harnessVersion) {
      throw new Error(`Harness request does not match run ${runId}`);
    }
  }

  private requestRow(runId: string, requestId: string): Promise<HarnessRequestRow | null> {
    return this.db.prepare(`
      SELECT run_id, request_id, harness_id, harness_version, request_json, request_hash
      FROM harness_requests WHERE run_id = ? AND request_id = ?
    `).bind(runId, requestId).first<HarnessRequestRow>();
  }

  private submissionRow(runId: string, requestId: string): Promise<HarnessSubmissionRow | null> {
    return this.db.prepare(`
      SELECT run_id, request_id, submission_id, harness_id, harness_version, submission_json, submission_hash
      FROM harness_submissions WHERE run_id = ? AND request_id = ?
    `).bind(runId, requestId).first<HarnessSubmissionRow>();
  }
}
