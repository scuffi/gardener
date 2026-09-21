import { canonicalSha256 } from "@gardener/core";
import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedEventV1,
  TaskBundleV1,
  TaskOutcomeV1,
  TaskRunRequestV1,
} from "@gardener/contracts";
import type {
  AgentHarness,
  HarnessOutcome,
  HarnessRequest,
  HarnessSubmission,
} from "../src/harness";
import { inspectRepositoryFixtureBundle } from "../src/task-runtime/fixture";
import {
  TaskHarnessRuntime,
  createTaskHarnessRequest,
  taskOutcomeAsJson,
  translateHarnessOutcome,
} from "../src/task-runtime/harness-adapter";

function event(kind: "github.workflow_dispatch" | "github.issue.opened" = "github.workflow_dispatch"): NormalizedEventV1 {
  const common = {
    schemaVersion: "gardener.normalized-event/v1" as const,
    eventId: "event:fixture:1",
    occurredAt: "2026-09-17T12:00:00.000Z",
    repository: {
      id: "1374842705",
      ownerId: "45369682",
      owner: "scuffi",
      name: "gardener-actions-v1-public-smoke",
      fullName: "scuffi/gardener-actions-v1-public-smoke",
      visibility: "public" as const,
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
    },
    workflow: {
      runId: "35256179260",
      runAttempt: 1,
      eventName: kind === "github.workflow_dispatch" ? "workflow_dispatch" as const : "issues" as const,
      workflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener-reusable.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted" as const,
    },
    actor: { id: "45369682", login: "scuffi" },
  };
  if (kind === "github.workflow_dispatch") return { ...common, kind, prompt: "Inspect this repository." };
  return {
    ...common,
    kind,
    issue: {
      id: "999",
      number: 1,
      title: "Fixture issue",
      body: "Please inspect this repository.",
      labels: ["gardener-test"],
      author: { id: "45369682", login: "scuffi" },
    },
  };
}

async function runRequest(bundleInput: Readonly<TaskBundleV1> = inspectRepositoryFixtureBundle()): Promise<TaskRunRequestV1> {
  const bundle = structuredClone(bundleInput) as TaskBundleV1;
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:fixture:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/fixture.issue-triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: event("github.issue.opened"),
    model: { id: "@cf/test/model" },
    admittedAt: "2026-09-17T12:00:00.000Z",
    deadlineAt: "2026-09-17T12:05:00.000Z",
  };
}

function completedHarnessOutcome(result: TaskOutcomeV1): HarnessOutcome {
  return {
    schemaVersion: "gardener.harness.outcome/v1",
    harness: { id: "flue", adapterVersion: "gardener-flue-native/v1" },
    runId: result.runId,
    requestId: "request",
    submissionId: "submission",
    status: "completed",
    result: { kind: "result", summary: result.status === "completed" ? result.summary : result.status, data: taskOutcomeAsJson(result) },
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, model: "@cf/test/model", turns: 2, toolCalls: 3 },
    events: [],
  };
}

class FixtureHarness implements AgentHarness {
  readonly descriptor = {
    id: "flue" as const,
    adapterVersion: "gardener-flue-native/v1",
    capabilities: ["reasoning", "structured-outcome", "workspace-tools", "tool-events", "model-usage", "cancellation"] as const,
    preview: false,
  };
  request: HarnessRequest | undefined;

  constructor(private readonly outcome: HarnessOutcome) {}

  async start(request: HarnessRequest): Promise<HarnessSubmission> {
    this.request = request;
    return {
      schemaVersion: "gardener.harness.submission/v1",
      harness: request.snapshot.harness,
      runId: request.runId,
      requestId: request.requestId,
      submissionId: "submission",
      acceptedAt: "2026-09-17T12:00:01.000Z",
    };
  }

  async submit(request: HarnessRequest): Promise<HarnessSubmission> { return this.start(request); }
  async read(): Promise<HarnessOutcome> { return this.outcome; }
  async cancel(request: { runId: string }): Promise<{ runId: string; cancelled: boolean }> {
    return { runId: request.runId, cancelled: true };
  }
}

describe("canonical task runtime framework", () => {
  it("adapts the immutable fixture bundle into a bounded Flue request", async () => {
    const input = await runRequest();
    const first = await createTaskHarnessRequest(input);
    const second = await createTaskHarnessRequest(input);

    expect(second).toEqual(first);
    expect(first.requestId).toMatch(/^task_[a-f0-9]{64}$/);
    expect(first.snapshot).toMatchObject({
      agentRevisionId: "task:fixture.issue-triage",
      agentRevisionHash: input.bundleHash,
      policySnapshotReference: `policy:${input.policySnapshotHash}`,
      harness: { id: "flue", adapterVersion: "gardener-flue-native/v1" },
    });
    expect(first.tools.map((tool) => [tool.name, tool.authority])).toEqual([
      ["repository_list_files", "observe"],
      ["repository_read_file", "observe"],
      ["repository_exec", "workspace"],
    ]);
    expect(first.tools.some((tool) => tool.name.includes("github"))).toBe(false);
    expect(first.prompt).toContain("Never claim a persistent effect occurred");
    expect(first.context?.[0]?.content).toContain("gardener.normalized-event/v1");
  });

  it("rejects a bundle whose canonical hash or deadline binding changed", async () => {
    const input = await runRequest();
    await expect(createTaskHarnessRequest({ ...input, bundleHash: "e".repeat(64) })).rejects.toThrow(/bundle hash/);
    await expect(createTaskHarnessRequest({ ...input, deadlineAt: "2026-09-17T12:05:01.000Z" })).rejects.toThrow(/runtime limit/);
  });

  it("walks issue triage through the harness seam to one declared comment proposal", async () => {
    const input = await runRequest();
    const expected: TaskOutcomeV1 = {
      schemaVersion: "gardener.task-outcome/v1",
      runId: input.runId,
      taskId: input.bundle.taskId,
      bundleHash: input.bundleHash,
      status: "completed",
      summary: "The repository contains a README and a smoke workflow.",
      observations: [{ kind: "repository", summary: "README.md was inspected.", paths: ["README.md"] }],
      proposedEffects: [{
        operationId: "operation:comment:1",
        kind: "issue.comment.create",
        issueNumber: 1,
        body: "Thanks for the report. The next step is a focused regression test.",
        rationale: "The repository evidence identifies the affected area.",
      }],
    };
    const harness = new FixtureHarness(completedHarnessOutcome(expected));
    await expect(new TaskHarnessRuntime(harness).run(input)).resolves.toEqual(expected);
    expect(harness.request?.tools).toHaveLength(3);
  });

  it("revalidates outcome binding and declared effects outside the model harness", async () => {
    const input = await runRequest();
    const undeclared: TaskOutcomeV1 = {
      schemaVersion: "gardener.task-outcome/v1",
      runId: input.runId,
      taskId: input.bundle.taskId,
      bundleHash: input.bundleHash,
      status: "completed",
      summary: "Proposed an effect without authority.",
      observations: [],
      proposedEffects: [{
        operationId: "operation:1",
        kind: "issue.labels.update",
        issueNumber: 1,
        add: ["not-allowed"],
        remove: [],
        rationale: "Fixture declares only comment creation.",
      }],
    };
    expect(() => translateHarnessOutcome(input, completedHarnessOutcome(undeclared))).toThrow(/undeclared effect/);
    expect(() => translateHarnessOutcome(input, completedHarnessOutcome({ ...undeclared, proposedEffects: [], runId: "run:other" }))).toThrow(/not bound/);
  });

  it("rejects events that do not match the bundle's declared trigger filters", async () => {
    const bundle = structuredClone(inspectRepositoryFixtureBundle()) as TaskBundleV1;
    bundle.triggers = [{ kind: "github.issue.opened", labelsAll: ["required"] }];
    const input = await runRequest(bundle);
    input.event = event("github.issue.opened");
    input.bundleHash = await canonicalSha256(bundle);
    await expect(createTaskHarnessRequest(input)).rejects.toThrow(/does not declare trigger/);
  });
});
