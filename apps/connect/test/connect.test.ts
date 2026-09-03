import { createHmac, generateKeyPairSync, webcrypto } from "node:crypto";
import { importPKCS8 } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { constantTimeEqual, decryptAccessCredentials, encryptAccessCredentials, sha256, verifyWebhookSignature } from "../src/crypto";
import { normalizeGitHubAppPrivateKey } from "../src/github";
import { canonicalOperationHash, cloudflareAccessRelayHeaders, normalizeIssueEvent, normalizePullRequestEvent, operationMatchesGrantResource } from "../src/index";
import { grantRequestSchema, instanceClaimSchema, operationSchema, parseRepositoryFullName } from "../src/schema";

beforeAll(() => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
});

describe("credential and webhook primitives", () => {
  it("hashes tokens and compares without accepting length mismatches", async () => {
    expect(await sha256("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });

  it("verifies the raw webhook body and rejects malformed signatures", async () => {
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    expect(await verifyWebhookSignature("hook-secret", body, signature)).toBe(true);
    expect(await verifyWebhookSignature("hook-secret", `${body} `, signature)).toBe(false);
    expect(await verifyWebhookSignature("hook-secret", body, null)).toBe(false);
  });

  it("normalizes GitHub-generated PKCS#1 App keys for Web Crypto", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    const pkcs8 = normalizeGitHubAppPrivateKey(pkcs1);
    expect(pkcs8).toContain("BEGIN PRIVATE KEY");
    await expect(importPKCS8(pkcs8, "RS256")).resolves.toBeDefined();
    expect(normalizeGitHubAppPrivateKey(pkcs8)).toBe(pkcs8);
  });

  it("encrypts instance-bound Cloudflare Access credentials and emits relay headers", async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
    const credentials = { clientId: "service-token.access", clientSecret: "test-client-secret" };
    const encrypted = await encryptAccessCredentials(encryptionKey, "instance-1", credentials);
    expect(encrypted).not.toContain(credentials.clientId);
    expect(encrypted).not.toContain(credentials.clientSecret);
    await expect(decryptAccessCredentials(encryptionKey, "instance-1", encrypted)).resolves.toEqual(credentials);
    await expect(decryptAccessCredentials(encryptionKey, "instance-2", encrypted)).rejects.toThrow();
    await expect(cloudflareAccessRelayHeaders({ ACCESS_CREDENTIAL_ENCRYPTION_KEY: encryptionKey }, "instance-1", encrypted)).resolves.toEqual({
      "CF-Access-Client-Id": credentials.clientId,
      "CF-Access-Client-Secret": credentials.clientSecret,
    });
    await expect(cloudflareAccessRelayHeaders({}, "instance-1", encrypted)).rejects.toThrow("encryption is unavailable");
    await expect(cloudflareAccessRelayHeaders({}, "instance-1", null)).resolves.toEqual({});
  });

  it("accepts optional strict Cloudflare Access credentials on instance claims", () => {
    const claim = { instanceId: "instance-1", callbackUrl: "https://gardener.example/hooks/connect" };
    expect(instanceClaimSchema.parse(claim).cloudflareAccess).toBeUndefined();
    expect(instanceClaimSchema.parse({ ...claim, cloudflareAccess: null }).cloudflareAccess).toBeNull();
    expect(instanceClaimSchema.parse({ ...claim, cloudflareAccess: { clientId: " id ", clientSecret: " secret " } }).cloudflareAccess).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(() => instanceClaimSchema.parse({ ...claim, cloudflareAccess: { clientId: "id" } })).toThrow();
    expect(() => instanceClaimSchema.parse({ ...claim, cloudflareAccess: { clientId: "id", clientSecret: "secret", extra: true } })).toThrow();
  });
});

describe("bounded connector contract", () => {
  const repository = { id: "9", installationId: "7", owner: "acme", name: "widgets", defaultBranch: "main" };
  const headSha = "abcdef1234567890abcdef1234567890abcdef12";
  const baseSha = "1234567890abcdef1234567890abcdef12345678";
  it("requires grants to identify the delivered event", () => {
    const operation = { schemaVersion: "v1", id: "label", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.label.add", label: "bug" };
    const request = { instanceId: "instance-1", runId: "run-1", repository, operations: [operation] };
    expect(() => grantRequestSchema.parse(request)).toThrow();
    expect(grantRequestSchema.parse({ ...request, eventId: "github:delivery-1" }).eventId).toBe("github:delivery-1");
  });

  it("accepts only strict typed maintainer operations", () => {
    expect(operationSchema.parse({ schemaVersion: "v1", id: "run:1", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.label.add", label: "triaged" }).kind).toBe("issue.label.add");
    expect(operationSchema.parse({ schemaVersion: "v1", id: "run:pr", repository, pullNumber: 3, expectedHeadSha: headSha, expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, kind: "pull_request.update", state: "closed" }).kind).toBe("pull_request.update");
    expect(operationSchema.parse({ schemaVersion: "v1", id: "run:branch", repository, kind: "branch.create", branch: "gardener/fix", fromSha: headSha }).kind).toBe("branch.create");
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "run:2", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.comment.create", body: "x".repeat(10_001) })).toThrow();
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "run:3", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.close", arbitraryEndpoint: "/user/keys" })).toThrow();
  });

  it("hashes the exact canonical operation payload", async () => {
    const operation = operationSchema.parse({ schemaVersion: "v1", id: "label", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.label.add", label: "bug" });
    const changed = operationSchema.parse({ schemaVersion: "v1", id: "label", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.label.add", label: "triaged" });
    expect(await canonicalOperationHash(operation)).toHaveLength(64);
    expect(await canonicalOperationHash(changed)).not.toBe(await canonicalOperationHash(operation));
  });

  it("binds operations to the delivered resource type and number", () => {
    const grant = { resourceKind: "issue" as const, resourceNumber: 2 };
    const label = operationSchema.parse({ schemaVersion: "v1", id: "label", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.label.add", label: "bug" });
    const update = operationSchema.parse({ schemaVersion: "v1", id: "update", repository, pullNumber: 3, expectedHeadSha: headSha, expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open", expectedDraft: false, kind: "pull_request.update", state: "closed" });
    const branch = operationSchema.parse({ schemaVersion: "v1", id: "branch", repository, kind: "branch.create", branch: "gardener/fix", fromSha: headSha });
    expect(operationMatchesGrantResource(label, grant)).toBe(true);
    expect(operationMatchesGrantResource(label, { ...grant, resourceNumber: 3 })).toBe(false);
    expect(operationMatchesGrantResource(update, { ...grant, resourceKind: "pull_request", resourceNumber: 3 })).toBe(true);
    expect(operationMatchesGrantResource(update, grant)).toBe(false);
    expect(operationMatchesGrantResource(branch, grant)).toBe(true);
    expect(operationMatchesGrantResource(branch, { ...grant, resourceKind: "pull_request" })).toBe(false);
  });

  it("normalizes supported issue webhooks without retaining the provider payload", () => {
    const normalized = normalizeIssueEvent({ action: "opened", installation: { id: 7 }, repository: { id: 9, name: "widgets", full_name: "acme/widgets", default_branch: "main", owner: { login: "acme" }, private: true }, issue: { id: 11, number: 2, title: "Bug", body: "Details", state: "open", html_url: "https://github.com/acme/widgets/issues/2", updated_at: "2026-09-02T12:00:00Z", user: { login: "octocat", email: "private@example.com" }, labels: [{ name: "bug", color: "red" }] } }, "delivery-1");
    expect(normalized?.event).toMatchObject({ deliveryId: "delivery-1", kind: "github.issue", repository, issue: { number: 2, author: "octocat", labels: ["bug"] } });
    expect(JSON.stringify(normalized)).not.toContain("private@example.com");
    expect(normalizeIssueEvent({ action: "opened", issue: { pull_request: {} } }, "x")).toBeNull();
  });

  it("normalizes supported pull request webhooks", () => {
    const normalized = normalizePullRequestEvent({ action: "synchronize", installation: { id: 7 }, repository: { id: 9, name: "widgets", default_branch: "main", owner: { login: "acme" } }, pull_request: { id: 21, number: 3, title: "Fix", body: "Details", state: "open", draft: false, merged: false, html_url: "https://github.com/acme/widgets/pull/3", updated_at: "2026-09-03T12:00:00Z", user: { login: "octocat" }, labels: [{ name: "bug" }], head: { ref: "fix", sha: headSha }, base: { ref: "main", sha: baseSha } } }, "delivery-pr");
    expect(normalized?.event).toMatchObject({ kind: "github.pull_request", action: "synchronize", pullRequest: { number: 3, head: { ref: "fix", sha: headSha }, base: { ref: "main", sha: baseSha } } });
  });

  it("rejects ambiguous repository names", () => {
    expect(parseRepositoryFullName("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRepositoryFullName("acme/../widgets")).toBeNull();
    expect(parseRepositoryFullName("acme/..")).toBeNull();
  });
});
