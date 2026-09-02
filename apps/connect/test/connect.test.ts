import { createHmac, webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { constantTimeEqual, sha256, verifyWebhookSignature } from "../src/crypto";
import { normalizeIssueEvent } from "../src/index";
import { grantRequestSchema, operationSchema, parseRepositoryFullName } from "../src/schema";

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
});

describe("bounded connector contract", () => {
  const repository = { id: "9", installationId: "7", owner: "acme", name: "widgets", defaultBranch: "main" };
  it("requires grants to identify the delivered event", () => {
    const request = { instanceId: "instance-1", runId: "run-1", repository, resource: { kind: "issue", number: 2 }, operations: ["issue.label.add"] };
    expect(() => grantRequestSchema.parse(request)).toThrow();
    expect(grantRequestSchema.parse({ ...request, eventId: "github:delivery-1" }).eventId).toBe("github:delivery-1");
  });

  it("accepts only strict typed issue operations", () => {
    expect(operationSchema.parse({ schemaVersion: "v1", id: "run:1", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.label.add", label: "triaged" }).kind).toBe("issue.label.add");
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "run:2", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.comment.create", body: "x".repeat(10_001) })).toThrow();
    expect(() => operationSchema.parse({ schemaVersion: "v1", id: "run:3", repository, issueNumber: 2, expectedIssueState: "open", kind: "issue.close", arbitraryEndpoint: "/user/keys" })).toThrow();
  });

  it("normalizes supported issue webhooks without retaining the provider payload", () => {
    const normalized = normalizeIssueEvent({ action: "opened", installation: { id: 7 }, repository: { id: 9, name: "widgets", full_name: "acme/widgets", default_branch: "main", owner: { login: "acme" }, private: true }, issue: { id: 11, number: 2, title: "Bug", body: "Details", state: "open", html_url: "https://github.com/acme/widgets/issues/2", updated_at: "2026-09-02T12:00:00Z", user: { login: "octocat", email: "private@example.com" }, labels: [{ name: "bug", color: "red" }] } }, "delivery-1");
    expect(normalized?.event).toMatchObject({ deliveryId: "delivery-1", kind: "github.issue", repository, issue: { number: 2, author: "octocat", labels: ["bug"] } });
    expect(JSON.stringify(normalized)).not.toContain("private@example.com");
    expect(normalizeIssueEvent({ action: "opened", issue: { pull_request: {} } }, "x")).toBeNull();
  });

  it("rejects ambiguous repository names", () => {
    expect(parseRepositoryFullName("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRepositoryFullName("acme/../widgets")).toBeNull();
    expect(parseRepositoryFullName("acme/..")).toBeNull();
  });
});
