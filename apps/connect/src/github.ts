import { isValidGitBranchName } from "@gardener/contracts";
import { importPKCS8, SignJWT } from "jose";
import type { Env } from "./env";
import type { Operation } from "./schema";
import { parseRepositoryFullName } from "./schema";

const API = "https://api.github.com";
const TIMEOUT = 10_000;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function sameInstant(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function asn1(tag: number, value: Uint8Array): Uint8Array {
  const length = value.length < 128
    ? new Uint8Array([value.length])
    : (() => {
        const bytes: number[] = [];
        for (let remaining = value.length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
        return new Uint8Array([0x80 | bytes.length, ...bytes]);
      })();
  return concatBytes(new Uint8Array([tag]), length, value);
}

/** GitHub-generated App keys are PKCS#1; Web Crypto and jose require PKCS#8. */
export function normalizeGitHubAppPrivateKey(input: string): string {
  const pem = input.replace(/\\n/g, "\n").trim();
  if (pem.includes("-----BEGIN PRIVATE KEY-----")) return `${pem}\n`;
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----")) throw new Error("Unsupported GitHub App private key format");
  const base64 = pem.replace(/-----BEGIN RSA PRIVATE KEY-----|-----END RSA PRIVATE KEY-----|\s/g, "");
  const pkcs1 = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const pkcs8 = asn1(0x30, concatBytes(version, rsaAlgorithm, asn1(0x04, pkcs1)));
  const encoded = btoa(String.fromCharCode(...pkcs8));
  return `-----BEGIN PRIVATE KEY-----\n${encoded.match(/.{1,64}/g)?.join("\n") ?? encoded}\n-----END PRIVATE KEY-----\n`;
}

async function appJwt(env: Env): Promise<string> {
  const key = await importPKCS8(normalizeGitHubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY), "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(env.GITHUB_APP_ID)
    .setIssuedAt(now - 60).setExpirationTime(now + 540).sign(key);
}

function headers(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "gardener-connect", "content-type": "application/json" };
}

async function github(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) });
}

async function jsonResponse(response: Response, context: string): Promise<unknown> {
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    throw new ConnectOperationError(status === 429 ? "github_rate_limited" : "github_http_error", `${context} failed (${status})`, status === 429 || status >= 500);
  }
  return response.json();
}

export async function exchangeOAuthCode(env: Env, code: string): Promise<{ id: string; login: string }> {
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "gardener-connect" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }), signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = await jsonResponse(exchange, "OAuth exchange");
  if (!record(data) || typeof data.access_token !== "string") throw new Error("OAuth exchange returned no token");
  const user = await jsonResponse(await github("/user", data.access_token), "GitHub user lookup");
  if (!record(user) || !positiveInteger(user.id) || typeof user.login !== "string") throw new Error("GitHub user response was invalid");
  return { id: String(user.id), login: user.login };
}

export interface InstallationInfo { id: string; accountId: string; accountLogin: string }
export async function getInstallation(env: Env, installationId: string): Promise<InstallationInfo> {
  if (!/^\d+$/.test(installationId)) throw new Error("Invalid installation id");
  const data = await jsonResponse(await github(`/app/installations/${installationId}`, await appJwt(env)), "Installation lookup");
  if (!record(data) || !positiveInteger(data.id) || !record(data.account) || !positiveInteger(data.account.id) || typeof data.account.login !== "string") throw new Error("Installation response was invalid");
  return { id: String(data.id), accountId: String(data.account.id), accountLogin: data.account.login };
}

type RepositoryPermissions = Record<string, "read" | "write">;

async function installationToken(env: Env, installationId: string, repositoryName: string, permissions: RepositoryPermissions): Promise<string> {
  const data = await jsonResponse(await github(`/app/installations/${installationId}/access_tokens`, await appJwt(env), {
    method: "POST", body: JSON.stringify({ repositories: [repositoryName], permissions }),
  }), "Installation token request");
  if (!record(data) || typeof data.token !== "string" || !data.token) throw new Error("Installation token response was invalid");
  return data.token;
}

export interface DiscoveredRepository { id: string; installationId: string; owner: string; name: string; defaultBranch?: string }
export async function fetchPullRequestForWebhook(env: Env, payload: unknown): Promise<unknown | null> {
  if (!record(payload) || !record(payload.issue) || payload.issue.pull_request === undefined || !positiveInteger(payload.issue.number) || !record(payload.repository) || typeof payload.repository.name !== "string" || !record(payload.repository.owner) || typeof payload.repository.owner.login !== "string" || !record(payload.installation) || !positiveInteger(payload.installation.id)) return null;
  const token = await installationToken(env, String(payload.installation.id), payload.repository.name, { metadata: "read", pull_requests: "read" });
  return jsonResponse(await github(`/repos/${encodeURIComponent(payload.repository.owner.login)}/${encodeURIComponent(payload.repository.name)}/pulls/${payload.issue.number}`, token), "Pull request webhook enrichment");
}

export async function discoverRepositories(env: Env, installationId: string): Promise<DiscoveredRepository[]> {
  const tokenData = await jsonResponse(await github(`/app/installations/${installationId}/access_tokens`, await appJwt(env), { method: "POST", body: JSON.stringify({ permissions: { metadata: "read" } }) }), "Installation token request");
  if (!record(tokenData) || typeof tokenData.token !== "string") throw new Error("Installation token response was invalid");
  const repositories: DiscoveredRepository[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await jsonResponse(await github(`/installation/repositories?per_page=100&page=${page}`, tokenData.token), "Repository discovery");
    if (!record(data) || !Array.isArray(data.repositories)) throw new Error("Repository discovery response was invalid");
    for (const item of data.repositories) {
      if (!record(item) || !positiveInteger(item.id) || typeof item.full_name !== "string") continue;
      const slug = parseRepositoryFullName(item.full_name); if (!slug) continue;
      repositories.push({ id: String(item.id), installationId, ...slug, ...(typeof item.default_branch === "string" ? { defaultBranch: item.default_branch } : {}) });
    }
    if (data.repositories.length < 100) break;
  }
  return repositories;
}

export type OperationResult = { status: "applied" | "already-applied"; githubId?: number | string; url?: string; providerRequestId?: string };
export class ConnectOperationError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = "ConnectOperationError"; }
}
type IssueOperation = Extract<Operation, { kind: "issue.label.add" | "issue.label.remove" | "issue.comment.create" | "issue.comment.update" | "issue.close" | "issue.reopen" }>;
type ExistingPullOperation = Extract<Operation, { pullNumber: number }>;

const IMPLEMENTED_OPERATION_KINDS = new Set<Operation["kind"]>([
  "issue.label.add", "issue.label.remove", "issue.comment.create", "issue.comment.update", "issue.close", "issue.reopen",
  "pull_request.review.submit", "pull_request.update", "branch.create", "commit.create", "pull_request.open_draft", "pull_request.merge",
]);

function operationPermissions(operation: Operation): RepositoryPermissions {
  if (!IMPLEMENTED_OPERATION_KINDS.has(operation.kind)) throw new ConnectOperationError("unsupported_operation", `Connect does not implement verified GitHub execution for ${operation.kind}`);
  if ("issueNumber" in operation) return { issues: "write", metadata: "read" };
  if (operation.kind === "branch.create" || operation.kind === "commit.create") return { contents: "write", metadata: "read" };
  if (operation.kind === "pull_request.merge") return { administration: "read", checks: "read", contents: "write", metadata: "read", pull_requests: "read", statuses: "read" };
  if (operation.kind === "pull_request.open_draft") return { contents: "read", metadata: "read", pull_requests: "write" };
  return { metadata: "read", pull_requests: "write" };
}

function repositoryPath(operation: Operation): string {
  return `/repos/${encodeURIComponent(operation.repository.owner)}/${encodeURIComponent(operation.repository.name)}`;
}

function operationMarker(id: string): string { return `<!-- gardener-operation:${id} -->`; }

async function commitMarker(env: Env, operation: Extract<Operation, { kind: "commit.create" }>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CONNECT_JWT_PRIVATE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(operation)));
  const mac = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `Gardener-Operation: ${operation.id}:${mac}`;
}

function authoredByApp(value: JsonRecord, env: Env): boolean {
  if (record(value.performed_via_github_app) && String(value.performed_via_github_app.id) === env.GITHUB_APP_ID) return true;
  return record(value.user) && String(value.user.login).toLowerCase() === `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
}

async function paginatedArray(path: string, token: string, label: string): Promise<JsonRecord[]> {
  const values: JsonRecord[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await jsonResponse(await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token), label);
    if (!Array.isArray(data)) throw new Error(`${label} response was invalid`);
    values.push(...data.filter(record));
    if (data.length < 100) return values;
  }
  throw new Error(`${label} exceeded the bounded idempotency scan`);
}

function refSha(value: unknown): string {
  if (!record(value) || !record(value.object) || typeof value.object.sha !== "string") throw new Error("GitHub reference response was invalid");
  return value.object.sha;
}

function pullHeadSha(value: unknown): string {
  if (!record(value) || !record(value.head) || typeof value.head.sha !== "string") throw new Error("GitHub pull request response was invalid");
  return value.head.sha;
}

function isSafeFilePath(value: string): boolean {
  const lower = value.toLowerCase();
  return lower !== ".git" && !lower.startsWith(".git/") && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function executeIssueOperation(env: Env, operation: IssueOperation, token: string): Promise<OperationResult> {
  const repoPath = repositoryPath(operation);
  const issuePath = `${repoPath}/issues/${operation.issueNumber}`;
  const issue = await jsonResponse(await github(issuePath, token), "Issue precondition lookup");
  if (!record(issue) || (issue.state !== "open" && issue.state !== "closed") || issue.pull_request !== undefined) throw new Error("Resource is not an issue");
  if (operation.kind === "issue.comment.create") {
    const marker = operationMarker(operation.id);
    const comments = await paginatedArray(`${issuePath}/comments?sort=created&direction=desc`, token, "Comment idempotency lookup");
    for (const comment of comments) if (authoredByApp(comment, env) && typeof comment.body === "string" && comment.body.includes(marker)) return { status: "already-applied", ...(positiveInteger(comment.id) ? { githubId: comment.id } : {}), ...(typeof comment.html_url === "string" ? { url: comment.html_url } : {}) };
  }
  const desired = operation.kind === "issue.close" ? "closed" : operation.kind === "issue.reopen" ? "open" : null;
  if (issue.state !== operation.expectedIssueState) throw new Error(`Precondition failed: issue state is ${String(issue.state)}`);
  if (!sameInstant(issue.updated_at, operation.expectedIssueUpdatedAt)) throw new Error("Precondition failed: issue changed after the operation was approved");

  if (operation.kind === "issue.label.add" || operation.kind === "issue.label.remove") {
    const labels = Array.isArray(issue.labels) ? issue.labels.flatMap((label) => record(label) && typeof label.name === "string" ? [label.name] : []) : [];
    const present = labels.some((label) => label.toLowerCase() === operation.label.toLowerCase());
    if ((operation.kind === "issue.label.add" && present) || (operation.kind === "issue.label.remove" && !present)) return { status: "already-applied" };
    const response = operation.kind === "issue.label.add"
      ? await github(`${issuePath}/labels`, token, { method: "POST", body: JSON.stringify({ labels: [operation.label] }) })
      : await github(`${issuePath}/labels/${encodeURIComponent(operation.label)}`, token, { method: "DELETE" });
    if (!response.ok) throw new ConnectOperationError(response.status === 429 ? "github_rate_limited" : "github_http_error", `GitHub label mutation failed (${response.status})`, response.status === 429 || response.status >= 500);
    await response.body?.cancel();
    return { status: "applied" };
  }
  if (operation.kind === "issue.close" || operation.kind === "issue.reopen") {
    const response = await github(issuePath, token, { method: "PATCH", body: JSON.stringify({ state: desired }) });
    if (!response.ok) throw new Error(`GitHub issue state mutation failed (${response.status})`);
    await response.body?.cancel();
    return { status: "applied" };
  }
  if (operation.kind === "issue.comment.update") {
    const existing = await jsonResponse(await github(`${repoPath}/issues/comments/${operation.commentId}`, token), "Comment lookup");
    const expectedLogin = `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
    const expectedIssueUrl = `${API}${issuePath}`;
    if (!record(existing) || existing.issue_url !== expectedIssueUrl) throw new Error("Comment is outside the granted issue");
    if (existing.updated_at !== operation.expectedCommentUpdatedAt) throw new Error("Precondition failed: comment changed after the operation was approved");
    if (!record(existing.user) || String(existing.user.login).toLowerCase() !== expectedLogin) throw new Error("Only comments owned by this GitHub App may be updated");
    if (existing.body === operation.body) return { status: "already-applied", ...(positiveInteger(existing.id) ? { githubId: existing.id } : {}), ...(typeof existing.html_url === "string" ? { url: existing.html_url } : {}) };
    return parseCommentResult(await jsonResponse(await github(`${repoPath}/issues/comments/${operation.commentId}`, token, { method: "PATCH", body: JSON.stringify({ body: operation.body }) }), "Comment update"));
  }
  const marker = operationMarker(operation.id);
  return parseCommentResult(await jsonResponse(await github(`${issuePath}/comments`, token, { method: "POST", body: JSON.stringify({ body: `${operation.body}\n${marker}` }) }), "Comment creation"));
}

async function pullRequest(repoPath: string, pullNumber: number, token: string): Promise<JsonRecord> {
  const value = await jsonResponse(await github(`${repoPath}/pulls/${pullNumber}`, token), "Pull request precondition lookup");
  if (!record(value) || !positiveInteger(value.number) || !record(value.head) || !record(value.base)) throw new Error("GitHub pull request response was invalid");
  return value;
}

function assertPullRevision(pull: JsonRecord, operation: ExistingPullOperation): void {
  const currentHead = pullHeadSha(pull);
  if (currentHead !== operation.expectedHeadSha) throw new Error(`Precondition failed: pull request head is ${currentHead}`);
  if (!record(pull.base) || typeof pull.base.ref !== "string" || typeof pull.base.sha !== "string") throw new Error("Pull request base revision was missing");
  if (pull.base.ref !== operation.expectedBaseRef || pull.base.sha !== operation.expectedBaseSha) throw new Error(`Precondition failed: pull request base is ${pull.base.ref} at ${pull.base.sha}`);
}

function assertPullEventState(pull: JsonRecord, operation: ExistingPullOperation): void {
  if (pull.state !== operation.expectedState) throw new Error(`Precondition failed: pull request state is ${String(pull.state)}`);
  if (pull.draft !== operation.expectedDraft) throw new Error("Precondition failed: pull request draft state changed");
  if (pull.updated_at !== operation.expectedPullUpdatedAt) throw new Error("Precondition failed: pull request changed after the operation was approved");
}

async function executeReview(env: Env, operation: Extract<Operation, { kind: "pull_request.review.submit" }>, token: string): Promise<OperationResult> {
  const repoPath = repositoryPath(operation);
  const pull = await pullRequest(repoPath, operation.pullNumber, token);
  assertPullRevision(pull, operation);
  assertPullEventState(pull, operation);
  const marker = operationMarker(operation.id);
  const expectedState = operation.event === "approve" ? "APPROVED" : operation.event === "request_changes" ? "CHANGES_REQUESTED" : "COMMENTED";
  const reviews = await paginatedArray(`${repoPath}/pulls/${operation.pullNumber}/reviews`, token, "Review idempotency lookup");
  for (const review of reviews) if (authoredByApp(review, env) && review.state === expectedState && review.commit_id === operation.expectedHeadSha && typeof review.body === "string" && review.body.includes(marker)) return { status: "already-applied", ...(positiveInteger(review.id) ? { githubId: review.id } : {}), ...(typeof review.html_url === "string" ? { url: review.html_url } : {}) };
  const current = await pullRequest(repoPath, operation.pullNumber, token);
  assertPullRevision(current, operation);
  assertPullEventState(current, operation);
  const result = await jsonResponse(await github(`${repoPath}/pulls/${operation.pullNumber}/reviews`, token, {
    method: "POST",
    body: JSON.stringify({
      commit_id: operation.expectedHeadSha,
      event: operation.event.toUpperCase(),
      body: `${operation.body}${operation.body ? "\n" : ""}${marker}`,
      comments: operation.comments.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })),
    }),
  }), "Pull request review");
  if (!record(result) || !positiveInteger(result.id)) throw new Error("GitHub review response was invalid");
  return { status: "applied", githubId: result.id, ...(typeof result.html_url === "string" ? { url: result.html_url } : {}) };
}

async function getReference(repoPath: string, branch: string, token: string): Promise<{ response: Response; data?: unknown }> {
  const response = await github(`${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (response.status === 404) { await response.body?.cancel(); return { response }; }
  return { response, data: await jsonResponse(response, "Git reference lookup") };
}

async function executeBranchCreate(operation: Extract<Operation, { kind: "branch.create" }>, token: string): Promise<OperationResult> {
  if (!isValidGitBranchName(operation.branch) || !operation.branch.startsWith("gardener/")) throw new Error("Branch name must use the gardener/ namespace");
  const repoPath = repositoryPath(operation);
  const existing = await getReference(repoPath, operation.branch, token);
  if (existing.data !== undefined) {
    if (refSha(existing.data) === operation.fromSha) return { status: "already-applied", url: `https://github.com/${operation.repository.owner}/${operation.repository.name}/tree/${encodeURIComponent(operation.branch)}` };
    throw new Error("Branch already exists at a different commit");
  }
  const created = await jsonResponse(await github(`${repoPath}/git/refs`, token, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${operation.branch}`, sha: operation.fromSha }) }), "Branch creation");
  return { status: "applied", githubId: refSha(created), url: `https://github.com/${operation.repository.owner}/${operation.repository.name}/tree/${encodeURIComponent(operation.branch)}` };
}

async function executeCommitCreate(env: Env, operation: Extract<Operation, { kind: "commit.create" }>, token: string): Promise<OperationResult> {
  if (!isValidGitBranchName(operation.branch) || !operation.branch.startsWith("gardener/")) throw new Error("Commit target must use the gardener/ branch namespace");
  if (operation.files.some((file) => !isSafeFilePath(file.path))) throw new Error("Commit contains an invalid file path");
  const deniedPaths = [".github/workflows/", ".github/actions/", ".github/dependabot.yml", ".github/codeowners", "codeowners", "docs/codeowners"];
  if (operation.files.some((file) => deniedPaths.some((prefix) => file.path.toLowerCase() === prefix || file.path.toLowerCase().startsWith(prefix)))) throw new Error("Commit touches a protected repository path");
  const totalBytes = operation.files.reduce((total, file) => total + (file.contentBase64 === null ? 0 : Math.floor(file.contentBase64.length * 3 / 4)), 0);
  if (totalBytes > 5_000_000) throw new Error("Commit content exceeds the 5 MB operation limit");
  const repoPath = repositoryPath(operation);
  const reference = await getReference(repoPath, operation.branch, token);
  if (reference.data === undefined) throw new Error("Target branch does not exist");
  const currentHead = refSha(reference.data);
  const marker = await commitMarker(env, operation);
  if (currentHead !== operation.expectedHeadSha) {
    const currentCommit = await jsonResponse(await github(`${repoPath}/git/commits/${encodeURIComponent(currentHead)}`, token), "Commit idempotency lookup");
    const expectedParent = record(currentCommit) && Array.isArray(currentCommit.parents) && record(currentCommit.parents[0]) ? currentCommit.parents[0].sha : undefined;
    if (record(currentCommit) && typeof currentCommit.message === "string" && currentCommit.message.split(/\r?\n/).includes(marker) && expectedParent === operation.expectedHeadSha) return { status: "already-applied", githubId: currentHead, url: `https://github.com/${operation.repository.owner}/${operation.repository.name}/commit/${currentHead}` };
    throw new Error(`Precondition failed: branch head is ${currentHead}`);
  }
  const parent = await jsonResponse(await github(`${repoPath}/git/commits/${encodeURIComponent(operation.expectedHeadSha)}`, token), "Parent commit lookup");
  if (!record(parent) || !record(parent.tree) || typeof parent.tree.sha !== "string") throw new Error("Parent commit response was invalid");
  const parentTree = await jsonResponse(await github(`${repoPath}/git/trees/${encodeURIComponent(parent.tree.sha)}?recursive=1`, token), "Parent tree lookup");
  if (!record(parentTree) || !Array.isArray(parentTree.tree) || parentTree.truncated === true) throw new Error("Parent tree response was invalid or truncated");
  const existingEntries = new Map(parentTree.tree.flatMap((entry) => record(entry) && typeof entry.path === "string" ? [[entry.path, entry] as const] : []));
  const tree = await Promise.all(operation.files.map(async (file) => {
    const existing = existingEntries.get(file.path);
    const mode = existing?.mode;
    if (existing && (existing.type !== "blob" || (mode !== "100644" && mode !== "100755"))) throw new Error(`Commit cannot replace unsupported Git object: ${file.path}`);
    if (file.contentBase64 === null) return { path: file.path, mode: mode === "100755" ? "100755" : "100644", type: "blob", sha: null };
    const blob = await jsonResponse(await github(`${repoPath}/git/blobs`, token, { method: "POST", body: JSON.stringify({ content: file.contentBase64, encoding: "base64" }) }), "Git blob creation");
    if (!record(blob) || typeof blob.sha !== "string") throw new Error("Git blob response was invalid");
    return { path: file.path, mode: mode === "100755" ? "100755" : "100644", type: "blob", sha: blob.sha };
  }));
  const createdTree = await jsonResponse(await github(`${repoPath}/git/trees`, token, { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree }) }), "Git tree creation");
  if (!record(createdTree) || typeof createdTree.sha !== "string") throw new Error("Git tree response was invalid");
  const createdCommit = await jsonResponse(await github(`${repoPath}/git/commits`, token, { method: "POST", body: JSON.stringify({ message: `${operation.message}\n\n${marker}`, tree: createdTree.sha, parents: [operation.expectedHeadSha] }) }), "Git commit creation");
  if (!record(createdCommit) || typeof createdCommit.sha !== "string") throw new Error("Git commit response was invalid");
  await jsonResponse(await github(`${repoPath}/git/refs/heads/${encodeURIComponent(operation.branch)}`, token, { method: "PATCH", body: JSON.stringify({ sha: createdCommit.sha, force: false }) }), "Branch fast-forward");
  return { status: "applied", githubId: createdCommit.sha, url: `https://github.com/${operation.repository.owner}/${operation.repository.name}/commit/${createdCommit.sha}` };
}

async function executePullOpen(env: Env, operation: Extract<Operation, { kind: "pull_request.open_draft" }>, token: string): Promise<OperationResult> {
  if (!isValidGitBranchName(operation.head) || !isValidGitBranchName(operation.base) || !operation.head.startsWith("gardener/")) throw new Error("Pull request branches are invalid or the head is outside the gardener/ namespace");
  const repoPath = repositoryPath(operation);
  const [head, base] = await Promise.all([getReference(repoPath, operation.head, token), getReference(repoPath, operation.base, token)]);
  if (head.data === undefined) throw new Error("Pull request head branch does not exist");
  if (base.data === undefined) throw new Error("Pull request base branch does not exist");
  if (refSha(head.data) !== operation.expectedHeadSha) throw new Error("Precondition failed: pull request head branch changed");
  if (refSha(base.data) !== operation.expectedBaseSha) throw new Error("Precondition failed: pull request base branch changed");
  const marker = operationMarker(operation.id);
  const query = new URLSearchParams({ state: "all", head: `${operation.repository.owner}:${operation.head}`, base: operation.base });
  const existing = await paginatedArray(`${repoPath}/pulls?${query}`, token, "Pull request idempotency lookup");
  for (const pull of existing) if (authoredByApp(pull, env) && typeof pull.body === "string" && pull.body.includes(marker)) {
    if (!record(pull.head) || pull.head.sha !== operation.expectedHeadSha || !record(pull.base) || pull.base.ref !== operation.base || pull.title !== operation.title || pull.draft !== operation.draft) throw new Error("Existing Gardener pull request does not match the approved operation");
    return { status: "already-applied", ...(positiveInteger(pull.number) ? { githubId: pull.number } : {}), ...(typeof pull.html_url === "string" ? { url: pull.html_url } : {}) };
  }
  const result = await jsonResponse(await github(`${repoPath}/pulls`, token, { method: "POST", body: JSON.stringify({ head: operation.head, base: operation.base, title: operation.title, body: `${operation.body}${operation.body ? "\n" : ""}${marker}`, draft: operation.draft }) }), "Pull request creation");
  if (!record(result) || !positiveInteger(result.number) || typeof result.html_url !== "string" || !record(result.head) || typeof result.head.sha !== "string" || !record(result.base) || typeof result.base.ref !== "string" || typeof result.base.sha !== "string") throw new Error("GitHub pull request creation response was invalid");
  if (result.head.sha !== operation.expectedHeadSha || result.base.ref !== operation.base || result.base.sha !== operation.expectedBaseSha) {
    const close = await github(`${repoPath}/pulls/${result.number}`, token, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    await close.body?.cancel();
    if (!close.ok) throw new Error(`Pull request revision changed during creation and cleanup failed for pull request #${result.number} (${close.status})`);
    throw new Error("Pull request revision changed during creation; the new pull request was closed");
  }
  return { status: "applied", githubId: result.number, url: result.html_url };
}

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await jsonResponse(await github("/graphql", token, { method: "POST", body: JSON.stringify({ query, variables }) }), "GitHub GraphQL mutation");
  if (!record(response) || (Array.isArray(response.errors) && response.errors.length)) throw new Error("GitHub GraphQL mutation failed");
  return response.data;
}

async function setPullDraft(token: string, nodeId: string, draft: boolean): Promise<void> {
  const mutation = draft
    ? "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}"
    : "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}";
  const data = await graphql(token, mutation, { id: nodeId });
  const field = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  if (!record(data) || !record(data[field]) || !record(data[field].pullRequest) || data[field].pullRequest.isDraft !== draft) {
    throw new Error("GitHub did not update pull request draft state");
  }
}

async function executePullUpdate(operation: Extract<Operation, { kind: "pull_request.update" }>, token: string): Promise<OperationResult> {
  const repoPath = repositoryPath(operation);
  let pull = await pullRequest(repoPath, operation.pullNumber, token);
  assertPullRevision(pull, operation);
  assertPullEventState(pull, operation);
  const desiredState = operation.state;
  const titleChanged = operation.title !== undefined && pull.title !== operation.title;
  const bodyChanged = operation.body !== undefined && pull.body !== operation.body;
  const stateChanged = desiredState !== undefined && pull.state !== desiredState;
  const draftChanged = operation.draft !== undefined && pull.draft !== operation.draft;
  if (!titleChanged && !bodyChanged && !stateChanged && !draftChanged) return { status: "already-applied", githubId: operation.pullNumber, ...(typeof pull.html_url === "string" ? { url: pull.html_url } : {}) };
  if (desiredState === "open" && pull.state !== "open") {
    pull = await jsonResponse(await github(`${repoPath}/pulls/${operation.pullNumber}`, token, { method: "PATCH", body: JSON.stringify({ state: "open" }) }), "Pull request reopen") as JsonRecord;
    assertPullRevision(pull, operation);
  }
  if (draftChanged) {
    pull = await pullRequest(repoPath, operation.pullNumber, token);
    assertPullRevision(pull, operation);
    if (typeof pull.node_id !== "string") throw new Error("Pull request node id was missing");
    await setPullDraft(token, pull.node_id, operation.draft!);
  }
  const patch: Record<string, unknown> = {};
  if (titleChanged) patch.title = operation.title;
  if (bodyChanged) patch.body = operation.body;
  if (desiredState === "closed" && pull.state !== "closed") patch.state = "closed";
  let result = pull;
  if (Object.keys(patch).length) {
    pull = await pullRequest(repoPath, operation.pullNumber, token);
    assertPullRevision(pull, operation);
    result = await jsonResponse(await github(`${repoPath}/pulls/${operation.pullNumber}`, token, { method: "PATCH", body: JSON.stringify(patch) }), "Pull request update") as JsonRecord;
  }
  return { status: "applied", githubId: operation.pullNumber, ...(typeof result.html_url === "string" ? { url: result.html_url } : {}) };
}

interface SuccessfulChecks { names: Set<string>; appChecks: Set<string> }
interface RequiredCheck { context: string; appId?: number }

export function successfulChecks(checks: unknown, statuses: unknown): SuccessfulChecks {
  const names = new Set<string>();
  const appChecks = new Set<string>();
  if (record(checks) && Array.isArray(checks.check_runs)) for (const check of checks.check_runs) {
    if (!record(check) || !["success", "neutral", "skipped"].includes(String(check.conclusion)) || typeof check.name !== "string") continue;
    names.add(check.name);
    if (record(check.app) && positiveInteger(check.app.id)) appChecks.add(`${check.app.id}:${check.name}`);
  }
  if (record(statuses) && Array.isArray(statuses.statuses)) for (const status of statuses.statuses) if (record(status) && status.state === "success" && typeof status.context === "string") names.add(status.context);
  return { names, appChecks };
}

function protectedChecks(protection: unknown): RequiredCheck[] {
  if (!record(protection) || !record(protection.required_status_checks)) return [];
  const required = protection.required_status_checks;
  const result: RequiredCheck[] = Array.isArray(required.contexts)
    ? required.contexts.flatMap((value) => typeof value === "string" ? [{ context: value }] : [])
    : [];
  if (Array.isArray(required.checks)) for (const value of required.checks) {
    if (!record(value) || typeof value.context !== "string") continue;
    result.push({ context: value.context, ...(positiveInteger(value.app_id) ? { appId: value.app_id } : {}) });
  }
  return [...new Map(result.map((check) => [`${check.appId ?? "any"}:${check.context}`, check])).values()];
}

async function executePullMerge(operation: Extract<Operation, { kind: "pull_request.merge" }>, token: string): Promise<OperationResult> {
  const repoPath = repositoryPath(operation);
  let pull = await pullRequest(repoPath, operation.pullNumber, token);
  assertPullRevision(pull, operation);
  assertPullEventState(pull, operation);
  if (pull.merged === true || typeof pull.merged_at === "string") return { status: "already-applied", githubId: operation.pullNumber, ...(typeof pull.html_url === "string" ? { url: pull.html_url } : {}) };
  if (pull.state !== "open") throw new Error("Pull request is not open");
  if (pull.draft !== operation.expectedDraft || pull.draft !== false) throw new Error("Pull request must be ready for review");
  if (!record(pull.base) || typeof pull.base.ref !== "string") throw new Error("Pull request base branch was missing");
  const repository = await jsonResponse(await github(repoPath, token), "Repository merge settings lookup");
  const methodField = operation.method === "merge" ? "allow_merge_commit" : operation.method === "squash" ? "allow_squash_merge" : "allow_rebase_merge";
  if (!record(repository) || repository[methodField] !== true) throw new Error(`Merge method ${operation.method} is not enabled for this repository`);
  const protectionResponse = await github(`${repoPath}/branches/${encodeURIComponent(pull.base.ref)}/protection`, token);
  if (protectionResponse.status === 404) { await protectionResponse.body?.cancel(); throw new Error("Base branch is not protected"); }
  const protection = await jsonResponse(protectionResponse, "Branch protection lookup");
  const [checks, statuses] = await Promise.all([
    jsonResponse(await github(`${repoPath}/commits/${encodeURIComponent(operation.expectedHeadSha)}/check-runs?per_page=100&filter=latest`, token), "Check run lookup"),
    jsonResponse(await github(`${repoPath}/commits/${encodeURIComponent(operation.expectedHeadSha)}/status?per_page=100`, token), "Commit status lookup"),
  ]);
  const successful = successfulChecks(checks, statuses);
  const required: RequiredCheck[] = [
    ...operation.requiredChecks,
    ...protectedChecks(protection),
  ];
  const uniqueRequired = [...new Map(required.map((check) => [`${check.appId ?? "any"}:${check.context}`, check])).values()];
  const missing = uniqueRequired.filter((check) => check.appId === undefined
    ? !successful.names.has(check.context)
    : !successful.appChecks.has(`${check.appId}:${check.context}`));
  if (missing.length) throw new Error(`Required checks are not successful: ${missing.map((check) => check.appId ? `${check.context} (App ${check.appId})` : check.context).join(", ")}`);
  pull = await pullRequest(repoPath, operation.pullNumber, token);
  assertPullRevision(pull, operation);
  assertPullEventState(pull, operation);
  if (pull.merged === true) throw new Error("Pull request eligibility changed before merge");
  const result = await jsonResponse(await github(`${repoPath}/pulls/${operation.pullNumber}/merge`, token, { method: "PUT", body: JSON.stringify({ sha: operation.expectedHeadSha, merge_method: operation.method }) }), "Pull request merge");
  if (!record(result) || result.merged !== true || typeof result.sha !== "string") throw new Error("GitHub did not merge the pull request");
  const mergedPull = await pullRequest(repoPath, operation.pullNumber, token);
  if (pullHeadSha(mergedPull) !== operation.expectedHeadSha || !record(mergedPull.base) || mergedPull.base.ref !== operation.expectedBaseRef) {
    throw new Error("Security incident: pull request target changed during merge");
  }
  return { status: "applied", githubId: result.sha, ...(typeof pull.html_url === "string" ? { url: pull.html_url } : {}) };
}

export async function executeGitHubOperation(env: Env, operation: Operation): Promise<OperationResult> {
  const { installationId, name } = operation.repository;
  const token = await installationToken(env, installationId, name, operationPermissions(operation));
  if (operation.kind === "issue.label.add" || operation.kind === "issue.label.remove" || operation.kind === "issue.comment.create" || operation.kind === "issue.comment.update" || operation.kind === "issue.close" || operation.kind === "issue.reopen") return executeIssueOperation(env, operation, token);
  switch (operation.kind) {
    case "pull_request.review.submit": return executeReview(env, operation, token);
    case "branch.create": return executeBranchCreate(operation, token);
    case "commit.create": return executeCommitCreate(env, operation, token);
    case "pull_request.open_draft": return executePullOpen(env, operation, token);
    case "pull_request.update": return executePullUpdate(operation, token);
    case "pull_request.merge": return executePullMerge(operation, token);
    case "issue.assignee.add": case "issue.assignee.remove":
    case "pull_request.comment.create": case "pull_request.comment.update":
    case "pull_request.reviewer.request": case "pull_request.reviewer.remove":
    case "discussion.comment.create": case "discussion.comment.update":
    case "discussion.answer.mark": case "discussion.answer.unmark": case "discussion.close": case "discussion.reopen":
    case "check.rerun":
    case "release.create": case "release.update": case "release.publish": case "release.delete":
      throw new ConnectOperationError("unsupported_operation", `Connect does not implement verified GitHub execution for ${operation.kind}`);
  }
}

function parseCommentResult(data: unknown): OperationResult {
  if (!record(data) || !positiveInteger(data.id) || typeof data.html_url !== "string") throw new Error("Comment mutation response was invalid");
  return { status: "applied", githubId: data.id, url: data.html_url };
}
