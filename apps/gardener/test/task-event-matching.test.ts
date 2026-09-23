import { describe, expect, it } from "vitest";
import {
  eventNameByTriggerKind,
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskRunRequestV1,
} from "@gardener/contracts";
import { canonicalSha256 } from "@gardener/core";
import { createTaskHarnessRequest } from "../src/task-runtime/harness-adapter";
import { inspectRepositoryFixtureBundle } from "../src/task-runtime/fixture";

const actor = { id: "45369682", login: "scuffi" };

function baseEvent(kind: NormalizedEventV1["kind"]) {
  return {
    schemaVersion: "gardener.normalized-event/v1" as const,
    eventId: "github:35256179260:1",
    occurredAt: "2026-09-17T12:00:00.000Z",
    repository: {
      id: "1374842705",
      ownerId: "45369682",
      owner: "scuffi",
      name: "gardener",
      fullName: "scuffi/gardener",
      visibility: "private" as const,
      commitSha: "b".repeat(40),
      ref: "refs/heads/main",
      defaultBranch: "main",
    },
    workflow: {
      runId: "35256179260",
      runAttempt: 1,
      eventName: eventNameByTriggerKind[kind],
      workflowRef: "scuffi/gardener/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef: "scuffi/gardener/.github/workflows/gardener-task.yml@" + "c".repeat(40),
      runnerEnvironment: "github-hosted" as const,
    },
    actor,
    kind,
  };
}

function pullRequestEvent(headRepoId: string | null): NormalizedEventV1 {
  return {
    ...baseEvent("github.pull_request.opened"),
    pullRequest: {
      id: "555",
      number: 12,
      title: "Improve docs",
      body: null,
      labels: ["ready"],
      author: actor,
      draft: false,
      state: "open",
      merged: false,
      updatedAt: "2026-09-22T12:00:00.000Z",
      base: { ref: "main", sha: "a".repeat(40), repo: { id: "1374842705", fullName: "scuffi/gardener" } },
      head: {
        ref: "feature",
        sha: "d".repeat(40),
        repo: headRepoId === null ? null : { id: headRepoId, fullName: "forker/gardener" },
      },
    },
  } as NormalizedEventV1;
}

function pushEvent(ref: string): NormalizedEventV1 {
  const event = baseEvent("github.push");
  return {
    ...event,
    repository: { ...event.repository, ref },
    push: {
      ref,
      before: "e".repeat(40),
      after: "f".repeat(40),
      forced: false,
      commits: [],
      includedCommits: 0,
      commitsTruncated: false,
    },
  } as NormalizedEventV1;
}

async function request(
  event: NormalizedEventV1,
  overrides: Partial<Pick<TaskBundleV1, "triggers" | "tools">> = {},
): Promise<TaskRunRequestV1> {
  const bundle = { ...structuredClone(inspectRepositoryFixtureBundle()), ...overrides } as TaskBundleV1;
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:fixture:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/fixture/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event,
    model: { id: "@cf/test/model" },
    admittedAt: "2026-09-17T12:00:00.000Z",
    deadlineAt: "2026-09-17T12:05:00.000Z",
  };
}

describe("trigger matching", () => {
  it("admits a same-repository pull request and rejects fork and deleted-fork heads", async () => {
    const triggers: TaskBundleV1["triggers"] = [{ kind: "github.pull_request.opened", labelsAll: [] }];
    await expect(createTaskHarnessRequest(await request(pullRequestEvent("1374842705"), { triggers })))
      .resolves.toBeDefined();
    await expect(createTaskHarnessRequest(await request(pullRequestEvent("9999"), { triggers })))
      .rejects.toThrow(/same-repository pull requests/);
    await expect(createTaskHarnessRequest(await request(pullRequestEvent(null), { triggers })))
      .rejects.toThrow(/a deleted repository/);
  });

  it("names repository.exec explicitly when a fork head is refused", async () => {
    await expect(createTaskHarnessRequest(await request(pullRequestEvent("9999"), {
      triggers: [{ kind: "github.pull_request.opened", labelsAll: [] }],
      tools: ["repository.list_files", "repository.exec"],
    }))).rejects.toThrow(/repository\.exec/);
  });

  it("enforces labelsAll against the resource the event is about", async () => {
    await expect(createTaskHarnessRequest(await request(pullRequestEvent("1374842705"), {
      triggers: [{ kind: "github.pull_request.opened", labelsAll: ["ready"] }],
    }))).resolves.toBeDefined();
    await expect(createTaskHarnessRequest(await request(pullRequestEvent("1374842705"), {
      triggers: [{ kind: "github.pull_request.opened", labelsAll: ["missing"] }],
    }))).rejects.toThrow(/does not declare trigger/);
  });

  it("evaluates push branch filters including negations", async () => {
    const triggers: TaskBundleV1["triggers"] = [{ kind: "github.push", branches: ["main", "release/*", "!release/wip"] }];
    await expect(createTaskHarnessRequest(await request(pushEvent("refs/heads/main"), { triggers })))
      .resolves.toBeDefined();
    await expect(createTaskHarnessRequest(await request(pushEvent("refs/heads/release/1.2"), { triggers })))
      .resolves.toBeDefined();
    await expect(createTaskHarnessRequest(await request(pushEvent("refs/heads/release/wip"), { triggers })))
      .rejects.toThrow(/does not declare trigger/);
    await expect(createTaskHarnessRequest(await request(pushEvent("refs/heads/other"), { triggers })))
      .rejects.toThrow(/does not declare trigger/);
  });

  it("applies branch patterns last-match-wins like GitHub does", async () => {
    // A positive pattern listed after a negation re-includes the branch.
    const reincluded: TaskBundleV1["triggers"] = [
      { kind: "github.push", branches: ["release/*", "!release/wip", "release/wip"] },
    ];
    await expect(createTaskHarnessRequest(await request(pushEvent("refs/heads/release/wip"), { triggers: reincluded })))
      .resolves.toBeDefined();

    // Reversing the order excludes it again.
    const excluded: TaskBundleV1["triggers"] = [
      { kind: "github.push", branches: ["release/*", "release/wip", "!release/wip"] },
    ];
    await expect(createTaskHarnessRequest(await request(pushEvent("refs/heads/release/wip"), { triggers: excluded })))
      .rejects.toThrow(/does not declare trigger/);
  });

  it("requires the scheduled cron to equal the declared cron", async () => {
    const scheduled = { ...baseEvent("github.schedule"), cron: "0 3 * * 1" } as NormalizedEventV1;
    await expect(createTaskHarnessRequest(await request(scheduled, {
      triggers: [{ kind: "github.schedule", cron: "0 3 * * 1" }],
    }))).resolves.toBeDefined();
    await expect(createTaskHarnessRequest(await request(scheduled, {
      triggers: [{ kind: "github.schedule", cron: "0 4 * * 1" }],
    }))).rejects.toThrow(/does not declare trigger/);
  });

  it("rejects an event kind the bundle never declared", async () => {
    await expect(createTaskHarnessRequest(await request(pullRequestEvent("1374842705"), {
      triggers: [{ kind: "github.issue.opened", labelsAll: [] }],
    }))).rejects.toThrow(/does not declare trigger github\.pull_request\.opened/);
  });
});
