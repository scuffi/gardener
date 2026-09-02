import { importPKCS8, SignJWT } from "jose";
import type { Env } from "./env";
import type { Operation } from "./schema";
import { parseRepositoryFullName } from "./schema";

const API = "https://api.github.com";
const TIMEOUT = 10_000;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

async function appJwt(env: Env): Promise<string> {
  const key = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"), "RS256");
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
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${context} failed (${response.status})`); }
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

async function installationToken(env: Env, installationId: string, repositoryName: string): Promise<string> {
  const data = await jsonResponse(await github(`/app/installations/${installationId}/access_tokens`, await appJwt(env), {
    method: "POST", body: JSON.stringify({ repositories: [repositoryName], permissions: { issues: "write", metadata: "read" } }),
  }), "Installation token request");
  if (!record(data) || typeof data.token !== "string" || !data.token) throw new Error("Installation token response was invalid");
  return data.token;
}

export interface DiscoveredRepository { id: string; installationId: string; owner: string; name: string; defaultBranch?: string }
export async function discoverRepositories(env: Env, installationId: string): Promise<DiscoveredRepository[]> {
  const tokenData = await jsonResponse(await github(`/app/installations/${installationId}/access_tokens`, await appJwt(env), { method: "POST", body: "{}" }), "Installation token request");
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

export type OperationResult = { status: "applied" | "already-applied"; githubId?: number; url?: string };

export async function executeGitHubOperation(env: Env, operation: Operation): Promise<OperationResult> {
  const { owner, name, installationId } = operation.repository;
  const slug = `${owner}/${name}`;
  const token = await installationToken(env, installationId, name);
  const issuePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${operation.issueNumber}`;
  const issue = await jsonResponse(await github(issuePath, token), "Issue precondition lookup");
  if (!record(issue) || (issue.state !== "open" && issue.state !== "closed") || issue.pull_request !== undefined) throw new Error("Resource is not an issue");
  const desired = operation.kind === "issue.close" ? "closed" : operation.kind === "issue.reopen" ? "open" : null;
  if (desired && issue.state === desired) return { status: "already-applied" };
  if (issue.state !== operation.expectedIssueState) throw new Error(`Precondition failed: issue state is ${String(issue.state)}`);

  if (operation.kind === "issue.label.add" || operation.kind === "issue.label.remove") {
    const labels = Array.isArray(issue.labels) ? issue.labels.flatMap((label) => record(label) && typeof label.name === "string" ? [label.name] : []) : [];
    const present = labels.some((label) => label.toLowerCase() === operation.label.toLowerCase());
    if ((operation.kind === "issue.label.add" && present) || (operation.kind === "issue.label.remove" && !present)) return { status: "already-applied" };
    const response = operation.kind === "issue.label.add"
      ? await github(`${issuePath}/labels`, token, { method: "POST", body: JSON.stringify({ labels: [operation.label] }) })
      : await github(`${issuePath}/labels/${encodeURIComponent(operation.label)}`, token, { method: "DELETE" });
    if (!response.ok) throw new Error(`GitHub label mutation failed (${response.status})`); await response.body?.cancel();
    return { status: "applied" };
  }
  if (operation.kind === "issue.close" || operation.kind === "issue.reopen") {
    const response = await github(issuePath, token, { method: "PATCH", body: JSON.stringify({ state: desired }) });
    if (!response.ok) throw new Error(`GitHub issue state mutation failed (${response.status})`); await response.body?.cancel();
    return { status: "applied" };
  }
  if (operation.kind === "issue.comment.update") {
    const existing = await jsonResponse(await github(`/repos/${slug}/issues/comments/${operation.commentId}`, token), "Comment lookup");
    const expectedLogin = `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
    const expectedIssueUrl = `${API}${issuePath}`;
    if (!record(existing) || existing.issue_url !== expectedIssueUrl) throw new Error("Comment is outside the granted issue");
    if (!record(existing.user) || String(existing.user.login).toLowerCase() !== expectedLogin) throw new Error("Only comments owned by this GitHub App may be updated");
    if (existing.body === operation.body) return { status: "already-applied", ...(positiveInteger(existing.id) ? { githubId: existing.id } : {}), ...(typeof existing.html_url === "string" ? { url: existing.html_url } : {}) };
    const result = await jsonResponse(await github(`/repos/${slug}/issues/comments/${operation.commentId}`, token, { method: "PATCH", body: JSON.stringify({ body: operation.body }) }), "Comment update");
    return parseCommentResult(result);
  }
  const marker = `<!-- gardener-operation:${operation.id} -->`;
  const comments = await jsonResponse(await github(`${issuePath}/comments?per_page=100&sort=created&direction=desc`, token), "Comment idempotency lookup");
  if (!Array.isArray(comments)) throw new Error("Comment list response was invalid");
  for (const comment of comments) if (record(comment) && typeof comment.body === "string" && comment.body.includes(marker)) return { status: "already-applied", ...(positiveInteger(comment.id) ? { githubId: comment.id } : {}), ...(typeof comment.html_url === "string" ? { url: comment.html_url } : {}) };
  const result = await jsonResponse(await github(`${issuePath}/comments`, token, { method: "POST", body: JSON.stringify({ body: `${operation.body}\n${marker}` }) }), "Comment creation");
  return parseCommentResult(result);
}

function parseCommentResult(data: unknown): OperationResult {
  if (!record(data) || !positiveInteger(data.id) || typeof data.html_url !== "string") throw new Error("Comment mutation response was invalid");
  return { status: "applied", githubId: data.id, url: data.html_url };
}
