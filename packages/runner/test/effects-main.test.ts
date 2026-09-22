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
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env.GITHUB_SHA = "b".repeat(40);
    process.env.GITHUB_RUN_ID = "2";
    process.env.GITHUB_RUN_ATTEMPT = "1";
  });

  it("verifies the artifact binding and creates exactly one marked comment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-effect-"));
    const plan = {
      schemaVersion: "gardener.task-effect-plan/v1",
      runId: "repo-1-run-2-attempt-1-plan",
      taskId: "fixture.issue-triage",
      taskName: "Issue triage",
      bundleHash: "a".repeat(64),
      repository: { id: "123", fullName: "owner/repo" },
      provenance: {
        sourcePath: ".gardener/tasks/triage/TASK.md",
        commitSha: "b".repeat(40),
        workflowRunId: "2",
        workflowRunAttempt: 1,
      },
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
    core.inputs.set("runtime-url", "https://gardener.example");
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
    const posted = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { body: string };
    expect(posted.body).toContain("## 🌱 Gardener · Issue triage");
    expect(posted.body).toContain("<summary>Gardener provenance</summary>");
    expect(posted.body).toContain(
      "https://github.com/owner/repo/blob/" + "b".repeat(40) + "/.gardener/tasks/triage/TASK.md",
    );
    expect(posted.body).toContain("https://github.com/owner/repo/actions/runs/2/attempts/1");
    expect(core.setOutput).toHaveBeenCalledWith("operation-id", "op_123");
    expect(core.recordEffect).toHaveBeenCalledWith(expect.objectContaining({
      planRunId: plan.runId,
      artifactSha256: core.inputs.get("expected-sha256"),
      operationId: "op_123",
      commentId: "99",
    }));
  });

  it("rejects a tampered artifact before GitHub or receipt recording", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-effect-tampered-"));
    const artifactPath = path.join(directory, "effect.json");
    const eventPath = path.join(directory, "event.json");
    await writeFile(artifactPath, "{}");
    await writeFile(eventPath, JSON.stringify({ action: "opened", issue: { number: 7 } }));
    core.inputs.set("artifact-path", artifactPath);
    core.inputs.set("expected-sha256", "0".repeat(64));
    core.inputs.set("github-token", "token");
    core.inputs.set("runtime-url", "https://gardener.example");
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/effects-main");
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledWith("Effect artifact digest mismatch"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(core.recordEffect).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "repository",
      repository: "other/repo",
      issueNumber: 7,
      error: "Effect repository binding mismatch",
    },
    {
      name: "issue",
      repository: "owner/repo",
      issueNumber: 8,
      error: "Effect issue binding mismatch",
    },
  ])("rejects a wrong $name binding before GitHub", async ({ repository, issueNumber, error }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-effect-binding-"));
    const plan = {
      schemaVersion: "gardener.task-effect-plan/v1",
      runId: "repo-1-run-2-attempt-1-plan",
      taskId: "fixture.issue-triage",
      taskName: "Issue triage",
      bundleHash: "a".repeat(64),
      repository: { id: "123", fullName: repository },
      provenance: {
        sourcePath: ".gardener/tasks/triage/TASK.md",
        commitSha: "b".repeat(40),
        workflowRunId: "2",
        workflowRunAttempt: 1,
      },
      issueNumber: 7,
      operationId: "op_binding",
      kind: "issue.comment.create",
      body: "This comment must not be posted.",
    };
    const artifact = Buffer.from(JSON.stringify(plan));
    const artifactPath = path.join(directory, "effect.json");
    const eventPath = path.join(directory, "event.json");
    await writeFile(artifactPath, artifact);
    await writeFile(eventPath, JSON.stringify({
      action: "opened",
      repository: { id: 123 },
      issue: { number: issueNumber },
    }));
    core.inputs.set("artifact-path", artifactPath);
    core.inputs.set("expected-sha256", createHash("sha256").update(artifact).digest("hex"));
    core.inputs.set("github-token", "token");
    core.inputs.set("runtime-url", "https://gardener.example");
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/effects-main");
    await vi.waitFor(() => expect(core.setFailed).toHaveBeenCalledWith(error));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(core.recordEffect).not.toHaveBeenCalled();
  });

  it("reconciles an existing operation marker without posting a duplicate", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gardener-effect-reconcile-"));
    const plan = {
      schemaVersion: "gardener.task-effect-plan/v1",
      runId: "repo-1-run-2-attempt-1-plan",
      taskId: "fixture.issue-triage",
      taskName: "Issue triage",
      bundleHash: "a".repeat(64),
      repository: { id: "123", fullName: "owner/repo" },
      provenance: {
        sourcePath: ".gardener/tasks/triage/TASK.md",
        commitSha: "b".repeat(40),
        workflowRunId: "2",
        workflowRunAttempt: 1,
      },
      issueNumber: 7,
      operationId: "op_existing",
      kind: "issue.comment.create",
      body: "Already posted.",
    };
    const artifact = Buffer.from(JSON.stringify(plan));
    const artifactPath = path.join(directory, "effect.json");
    const eventPath = path.join(directory, "event.json");
    await writeFile(artifactPath, artifact);
    await writeFile(eventPath, JSON.stringify({
      action: "opened",
      repository: { id: 123 },
      issue: { number: 7 },
    }));
    core.inputs.set("artifact-path", artifactPath);
    core.inputs.set("expected-sha256", createHash("sha256").update(artifact).digest("hex"));
    core.inputs.set("github-token", "token");
    core.inputs.set("runtime-url", "https://gardener.example");
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = "owner/repo";
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json([{
      id: 99,
      html_url: "https://github.test/comment/99",
      body: "Already posted.\n<!-- gardener-operation:op_existing -->",
    }]));
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/effects-main");
    await vi.waitFor(() => expect(core.setOutput).toHaveBeenCalledWith("comment-id", "99"));

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(core.recordEffect).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op_existing",
      commentId: "99",
    }));
  });
});
