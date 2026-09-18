import { describe, expect, it } from "vitest";
import {
  normalizedEventV1Schema,
  taskBundleV1Schema,
  taskOutcomeV1Schema,
  taskRunRequestV1Schema,
  taskToolResultV1Schema,
  type NormalizedEventV1,
  type TaskBundleV1,
} from "../src/task";

const hash = "a".repeat(64);

function fixtureBundle(): TaskBundleV1 {
  return {
    schemaVersion: "gardener.task-bundle/v1",
    taskId: "fixture.inspect",
    name: "Fixture repository inspection",
    description: "Inspect repository state and return a structured report.",
    instructions: "Inspect the checked-out repository. Report only evidence obtained through declared tools.",
    triggers: [{ kind: "github.workflow_dispatch" }],
    tools: ["repository.list_files", "repository.read_file", "repository.exec"],
    effects: [],
    planningNetwork: "unrestricted",
    limits: {
      runtimeSeconds: 300,
      maxTurns: 8,
      maxToolCalls: 24,
      inputTokens: 64_000,
      outputTokens: 8_000,
    },
  };
}

function fixtureEvent(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:fixture:1",
    kind: "github.workflow_dispatch",
    occurredAt: "2026-09-17T12:00:00.000Z",
    repository: {
      id: "1374842705",
      ownerId: "45369682",
      owner: "scuffi",
      name: "gardener-actions-v1-public-smoke",
      fullName: "scuffi/gardener-actions-v1-public-smoke",
      visibility: "public",
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
    },
    workflow: {
      runId: "35256179260",
      runAttempt: 1,
      eventName: "workflow_dispatch",
      workflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener-reusable.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted",
    },
    actor: { id: "45369682", login: "scuffi" },
    prompt: "Inspect this repository.",
  };
}

describe("Actions-native task v1 contracts", () => {
  it("accepts a repository-independent fixture bundle and rejects hidden authority", () => {
    expect(taskBundleV1Schema.parse(fixtureBundle())).toEqual(fixtureBundle());
    expect(() => taskBundleV1Schema.parse({ ...fixtureBundle(), githubToken: "secret" })).toThrow();
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      tools: [...fixtureBundle().tools, "github.issue.comment"],
    })).toThrow();
  });

  it("requires unique trigger, tool, and effect declarations", () => {
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      tools: ["repository.exec", "repository.exec"],
    })).toThrow(/unique/);
    expect(() => taskBundleV1Schema.parse({
      ...fixtureBundle(),
      triggers: [{ kind: "github.workflow_dispatch" }, { kind: "github.workflow_dispatch" }],
    })).toThrow(/unique/);
  });

  it("binds normalized events to numeric GitHub identity and hosted workflow context", () => {
    expect(normalizedEventV1Schema.parse(fixtureEvent())).toEqual(fixtureEvent());
    expect(() => normalizedEventV1Schema.parse({
      ...fixtureEvent(),
      repository: { ...fixtureEvent().repository, ownerId: "scuffi" },
    })).toThrow();
    expect(() => normalizedEventV1Schema.parse({
      ...fixtureEvent(),
      workflow: { ...fixtureEvent().workflow, runnerEnvironment: "self-hosted" },
    })).toThrow();
  });

  it("defines one immutable bundle/event/model/deadline run request", () => {
    const request = {
      schemaVersion: "gardener.task-run-request/v1",
      runId: "run:fixture:1",
      bundle: fixtureBundle(),
      bundleHash: hash,
      policySnapshotHash: "d".repeat(64),
      event: fixtureEvent(),
      model: { id: "@cf/test/model" },
      admittedAt: "2026-09-17T12:00:00.000Z",
      deadlineAt: "2026-09-17T12:05:00.000Z",
    } as const;
    expect(taskRunRequestV1Schema.parse(request)).toEqual(request);
    expect(() => taskRunRequestV1Schema.parse({
      ...request,
      deadlineAt: request.admittedAt,
    })).toThrow(/deadline/);
  });

  it("keeps shell results structured and process-state consistent", () => {
    const result = {
      schemaVersion: "gardener.task-tool-result/v1",
      operationId: "run:fixture:1:operation:1",
      tool: "repository.exec",
      status: "completed",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      outputTruncated: false,
    } as const;
    expect(taskToolResultV1Schema.parse(result)).toEqual(result);
    expect(() => taskToolResultV1Schema.parse({ ...result, status: "timed_out", exitCode: 0 })).toThrow(/exitCode/);
  });

  it("accepts the first inspect-only structured outcome with no proposed effects", () => {
    const outcome = {
      schemaVersion: "gardener.task-outcome/v1",
      runId: "run:fixture:1",
      taskId: fixtureBundle().taskId,
      bundleHash: hash,
      status: "completed",
      summary: "The repository contains a README and its smoke workflow is configured.",
      observations: [{ kind: "repository", summary: "README.md was inspected.", paths: ["README.md"] }],
      proposedEffects: [],
    } as const;
    expect(taskOutcomeV1Schema.parse(outcome)).toEqual(outcome);
    expect(() => taskOutcomeV1Schema.parse({ ...outcome, providerReceipt: { id: "not-allowed" } })).toThrow();
  });
});
