import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  inputs: new Map<string, string>(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  recordEffect: vi.fn(async () => undefined),
}));

vi.mock("@actions/core", () => ({
  getInput: (name: string) => core.inputs.get(name) ?? "",
  setOutput: core.setOutput,
  setFailed: core.setFailed,
  setSecret: core.setSecret,
  getIDToken: vi.fn(async () => "oidc-token"),
}));

vi.mock("capnweb", () => ({
  RpcTarget: class {},
  newWebSocketRpcSession: vi.fn(() => ({
    authenticate: () => ({ recordEffect: core.recordEffect }),
    [Symbol.dispose]: vi.fn(),
  })),
}));

vi.mock("../src/context", () => ({
  helloFromOidcToken: vi.fn(() => ({ phase: "effects" })),
  sessionSocketUrl: vi.fn(() => "wss://gardener.example/session/effects"),
}));

describe("exact issue-comment effects action", () => {
  beforeEach(() => {
    core.inputs.clear();
    vi.clearAllMocks();
  });

  it("verifies the artifact binding and creates exactly one marked comment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-effect-"));
    const plan = {
      schemaVersion: "gardener.task-effect-plan/v1",
      runId: "repo-1-run-2-attempt-1-plan",
      taskId: "fixture.issue-triage",
      bundleHash: "a".repeat(64),
      repository: { id: "123", fullName: "owner/repo" },
      issueNumber: 7,
      operationId: "op_123",
      kind: "issue.comment.create",
      body: "Thanks for the report. The next step is a regression test.",
    };
    const artifact = Buffer.from(JSON.stringify(plan));
    const artifactPath = path.join(directory, "effect.json");
    const eventPath = path.join(directory, "event.json");
    await writeFile(artifactPath, artifact);
    await writeFile(eventPath, JSON.stringify({ action: "opened", repository: { id: 123 }, issue: { number: 7 } }));
    core.inputs.set("artifact-path", artifactPath);
    core.inputs.set("expected-sha256", createHash("sha256").update(artifact).digest("hex"));
    core.inputs.set("github-token", "token");
    core.inputs.set("harness-url", "https://gardener.example");
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(Response.json({ id: 99, html_url: "https://github.test/comment/99" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/effects-main");
    await vi.waitFor(() => expect(core.setOutput).toHaveBeenCalledWith("comment-id", "99"));

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining("<!-- gardener-operation:op_123 -->"),
    });
    expect(core.setOutput).toHaveBeenCalledWith("operation-id", "op_123");
    expect(core.recordEffect).toHaveBeenCalledWith(expect.objectContaining({
      planRunId: plan.runId,
      artifactSha256: core.inputs.get("expected-sha256"),
      operationId: "op_123",
      commentId: "99",
    }));
  });
});
