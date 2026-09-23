import { describe, expect, it } from "vitest";
import type { NormalizedEventV1, TaskBundleV1, TaskRunRequestV1 } from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";
import { createTaskHarnessRequest } from "../src/task-runtime/harness-adapter";
import { inspectRepositoryFixtureBundle } from "../src/task-runtime/fixture";
import { actionToolAuthority, taskDeclaresActionAuthority } from "../src/task-runtime/tool-authority";

function issueEvent(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:fixture:1",
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
      defaultBranch: "main",
    },
    workflow: {
      runId: "35256179260",
      runAttempt: 1,
      eventName: "issues",
      workflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener-actions-v1-public-smoke/.github/workflows/gardener-reusable.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted",
    },
    actor: { id: "45369682", login: "scuffi" },
    kind: "github.issue.opened",
    issue: {
      id: "999",
      number: 1,
      title: "Fixture issue",
      body: "Please inspect this repository.",
      state: "open",
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: ["gardener-test"],
      author: { id: "45369682", login: "scuffi" },
    },
  };
}

async function requestWithTools(tools: TaskBundleV1["tools"]): Promise<TaskRunRequestV1> {
  const bundle = { ...structuredClone(inspectRepositoryFixtureBundle()), tools } as TaskBundleV1;
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:fixture:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/fixture.issue-triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: issueEvent(),
    model: { id: "@cf/test/model" },
    admittedAt: "2026-09-17T12:00:00.000Z",
    deadlineAt: "2026-09-17T12:05:00.000Z",
  };
}

describe("provider read capability exposure", () => {
  it("advertises provider_api_read only when the bundle declares it", async () => {
    const without = await createTaskHarnessRequest(await requestWithTools(["repository.list_files"]));
    expect(without.tools.map((tool) => tool.name)).not.toContain("provider_api_read");

    const withRead = await createTaskHarnessRequest(
      await requestWithTools(["repository.list_files", "provider.api.read"]),
    );
    const descriptor = withRead.tools.find((tool) => tool.name === "provider_api_read");
    expect(descriptor).toBeDefined();
    expect(descriptor?.authority).toBe("observe");
  });

  it("describes the read tool as non-mutating with both transports", async () => {
    const request = await createTaskHarnessRequest(
      await requestWithTools(["repository.list_files", "provider.api.read"]),
    );
    const description = request.tools.find((tool) => tool.name === "provider_api_read")?.description ?? "";
    expect(description).toMatch(/cannot mutate/i);
    expect(description).toMatch(/rest/i);
    expect(description).toMatch(/graphql/i);
  });

  it("never places a provider token in the harness request", async () => {
    const request = await createTaskHarnessRequest(
      await requestWithTools(["repository.list_files", "provider.api.read"]),
    );
    expect(JSON.stringify(request)).not.toMatch(/gh[pso]_|github-token|authorization/i);
  });
});

describe("runner action tool authority", () => {
  it("authorizes github.read only from the declared provider read tool", () => {
    expect(actionToolAuthority("github.read")).toEqual(["provider_api_read"]);
    expect(taskDeclaresActionAuthority(["provider.api.read"], "github.read")).toBe(true);
    expect(taskDeclaresActionAuthority(["repository.exec"], "github.read")).toBe(false);
    expect(taskDeclaresActionAuthority([], "github.read")).toBe(false);
  });

  it("authorizes shell.exec from any declared repository tool and none otherwise", () => {
    // All three repository tools run as shell commands, so any one of them
    // authorizes the transport.
    for (const tool of ["repository.exec", "repository.read_file", "repository.list_files"] as const) {
      expect(taskDeclaresActionAuthority([tool], "shell.exec"), tool).toBe(true);
    }
    // A task with only provider reads must never reach a shell.
    expect(taskDeclaresActionAuthority(["provider.api.read"], "shell.exec")).toBe(false);
    expect(taskDeclaresActionAuthority([], "shell.exec")).toBe(false);
  });

  it("reserves repository.capture exclusively for trusted terminal code", () => {
    expect(actionToolAuthority("repository.capture")).toEqual([]);
    expect(taskDeclaresActionAuthority(["repository.exec"], "repository.capture")).toBe(false);
    expect(taskDeclaresActionAuthority(["provider.api.read"], "repository.capture")).toBe(false);
  });

  it("never leaves a model-requestable action kind unauthorized by default", () => {
    for (const kind of ["github.read", "shell.exec"] as const) {
      expect(actionToolAuthority(kind).length, kind).toBeGreaterThan(0);
    }
  });
});
