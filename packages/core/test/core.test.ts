import { describe, expect, it, vi } from "vitest";
import { operationKindSchema, type Policy } from "@gardener/contracts";
import { compileWorkflow, createOperationId, DeterministicMockAgentRuntime, evaluatePolicy, WorkersAiIssueGardenerRuntime } from "../src";

const repository = { provider: "github" as const, id: "R1", installationId: "I1", owner: "acme", name: "garden" };
const event = {
  schemaVersion: "v1" as const, id: "e1", deliveryId: "d1", instanceId: "i1", kind: "github.issue" as const, action: "opened" as const,
  occurredAt: "2026-09-02T12:00:00.000Z", repository,
  issue: { id: "issue-1", number: 1, title: "App crashes", body: "broken on start", state: "open" as const, labels: [], author: "octo", htmlUrl: "https://github.com/acme/garden/issues/1" },
};
const modes = Object.fromEntries(operationKindSchema.options.map((kind) => [kind, "automatic"])) as Policy["modes"];
const policy: Policy = { schemaVersion: "v1", id: "p1", name: "Safe", modes, allowedMergeMethods: ["squash"], requiredChecks: ["test"], maxCommentLength: 100, maxChangedFiles: 5, deniedPathPrefixes: [".github/workflows/"] };
const workflow = { schemaVersion: "v1" as const, id: "w1", name: "Issues", revision: 1, paused: true, triggers: [{ kind: "event" as const, events: ["github.issue" as const] }], repositories: ["R1"], instructions: "Classify issues", runtime: "workers-ai.issue-gardener" as const, model: "model", allowedOperations: ["issue.label.add" as const] };

describe("workflow compilation", () => {
  it("creates stable plan ids and detached immutable snapshots", () => {
    const first = compileWorkflow(workflow, policy, { now: () => new Date("2026-09-02T12:00:00Z") });
    const second = compileWorkflow(workflow, policy, { now: () => new Date("2026-09-03T12:00:00Z") });
    expect(first.planId).toBe(second.planId);
    expect(Object.isFrozen(first.definition.limits)).toBe(true);
    expect(() => { (first.definition as { name: string }).name = "changed"; }).toThrow();
  });

  it("creates retry-stable operation ids", () => {
    expect(createOperationId("run-1", 2)).toBe("run-1:operation:2");
    expect(() => createOperationId("run-1", -1)).toThrow();
  });
});

describe("policy evaluation", () => {
  it("requires approval and enforces invariants before approval", () => {
    const operation = { schemaVersion: "v1" as const, id: "op1", kind: "issue.comment.create" as const, repository, issueNumber: 1, expectedIssueState: "open" as const, body: "hello" };
    const approvalPolicy = { ...policy, modes: { ...modes, "issue.comment.create": "approval" as const } };
    expect(evaluatePolicy(operation, approvalPolicy, { current: { issueState: "open" } }).outcome).toBe("approval_required");
    expect(evaluatePolicy(operation, approvalPolicy, { current: { issueState: "closed" } }).outcome).toBe("denied");
  });

  it("fails merge closed when current safety state is incomplete", () => {
    const headSha = "abcdef1234567890abcdef1234567890abcdef12";
    const baseSha = "1234567890abcdef1234567890abcdef12345678";
    const merge = { schemaVersion: "v1" as const, id: "op2", kind: "pull_request.merge" as const, repository, pullNumber: 2, expectedHeadSha: headSha, expectedBaseRef: "main", expectedBaseSha: baseSha, expectedState: "open" as const, method: "squash" as const, expectedDraft: false as const, requiredChecks: [{ context: "test", appId: 123 }] };
    expect(evaluatePolicy(merge, policy, { current: { headSha, baseRef: "main", baseSha, draft: false, successfulChecks: ["test"] } }).outcome).toBe("denied");
    expect(evaluatePolicy(merge, policy, { current: { headSha, baseRef: "main", baseSha, draft: false, successfulChecks: ["test"], branchProtectionAllowsMerge: true } }).outcome).toBe("authorized");
    expect(evaluatePolicy(merge, policy, { current: { headSha, baseRef: "release", baseSha, draft: false, successfulChecks: ["test"], branchProtectionAllowsMerge: true } }).outcome).toBe("denied");
  });
});

describe("agent runtimes", () => {
  const request = { schemaVersion: "v1" as const, runId: "run-1", model: "model", instructions: "Classify", event, maxOperations: 4, maxInputTokens: 32_000, maxOutputTokens: 800 };
  it("uses an injected Workers AI binding and validates its output", async () => {
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify({ summary: "A bug", labels: ["bug"], comment: null, rationale: "Crash report" }), usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const runtime = new WorkersAiIssueGardenerRuntime({ run });
    const handle = await runtime.start(request);
    expect((await runtime.status(handle)).state).toBe("succeeded");
    expect((await runtime.result(handle))?.proposals[0]?.operation.id).toMatch(/^run-1:operation:0:[a-f0-9]{32}$/);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toMatchObject({ max_tokens: 800, response_format: { type: "json_schema" } });
    expect(await runtime.start(request)).toEqual(handle);
    expect(run).toHaveBeenCalledOnce();
  });

  it("is deterministic without I/O", async () => {
    const one = new DeterministicMockAgentRuntime();
    const two = new DeterministicMockAgentRuntime();
    const a = await one.result(await one.start(request));
    const b = await two.result(await two.start(request));
    expect(a).toEqual(b);
    expect(a?.proposals[0]?.operation.kind).toBe("issue.label.add");
  });
});
