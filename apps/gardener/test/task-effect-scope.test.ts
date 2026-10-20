import { canonicalSha256 } from "@gardener/core";
import { describe, expect, it } from "vitest";
import {
  type NormalizedEventV1,
  type TaskBundleV1,
  type TaskEffectProposalV1,
  type TaskRunRequestV1,
  type TaskRunStarterV1,
} from "@gardener/contracts";
import { buildTaskEffectPlan, type CompletedTaskOutcomeV1 } from "../src/task-runtime/effect-plan";
import { createTaskHarnessRequest } from "../src/task-runtime/harness-adapter";
import { proposalAuthorityRefusal, runEffectScope } from "../src/task-runtime/proposal-authority";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";

const COMMIT = "b".repeat(40);
const CURRENT_PIN = `scuffi/gardener/.github/workflows/gardener-task.yml@${"c".repeat(40)}`;
/** 0.1.16's task workflow, whose apply cannot parse `effectScope`. */
const OLD_PIN = "scuffi/gardener/.github/workflows/gardener-task.yml@242825edd810a0219e008e3d68081c5cde6dc1ee";

const TRUSTED: TaskRunStarterV1 = { trusted: true, reason: "maintainer_author" };
const OUTSIDER: TaskRunStarterV1 = { trusted: false, reason: "author_not_maintainer" };
const BOT: TaskRunStarterV1 = { trusted: false, reason: "bot" };

function issueEvent(jobWorkflowRef = CURRENT_PIN): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:1",
    occurredAt: "2026-10-20T12:00:00.000Z",
    kind: "github.issue.opened",
    repository: {
      id: "1374842705", ownerId: "45369682", owner: "scuffi", name: "demo", fullName: "scuffi/demo",
      visibility: "public", commitSha: COMMIT, ref: "refs/heads/main", defaultBranch: "main",
    },
    workflow: {
      runId: "35256179260", runAttempt: 1, eventName: "issues",
      workflowRef: "scuffi/demo/.github/workflows/gardener.yml@refs/heads/main",
      jobWorkflowRef, runnerEnvironment: "github-hosted",
    },
    actor: { id: "2", login: "outsider" },
    issue: {
      id: "999", number: 1, title: "Bug", body: "Broken", state: "open", updatedAt: "2026-10-20T12:00:00.000Z",
      labels: [], author: { id: "2", login: "outsider" }, authorAssociation: "NONE",
    },
  };
}

async function runRequest(options: {
  starter?: TaskRunStarterV1;
  effectScope?: "trigger";
  jobWorkflowRef?: string;
} = {}): Promise<TaskRunRequestV1> {
  const bundle = structuredClone(inspectRepositoryFixtureBundle()) as TaskBundleV1;
  bundle.effects = ["issue.comment.create", "issue.create", "check.rerun"];
  bundle.triggers = [{ kind: "github.issue.opened", labelsAll: [], mentions: [], authors: "any" }, { kind: "github.workflow_dispatch" }];
  if (options.effectScope !== undefined) bundle.effectScope = options.effectScope;
  return {
    schemaVersion: "gardener.task-run-request/v1",
    runId: "run:scope:1",
    bundle,
    bundleHash: await canonicalSha256(bundle),
    sourcePath: ".gardener/tasks/triage/TASK.md",
    policySnapshotHash: "d".repeat(64),
    event: issueEvent(options.jobWorkflowRef),
    model: { id: "@cf/test/model" },
    admittedAt: "2026-10-20T12:00:00.000Z",
    deadlineAt: "2026-10-20T12:05:00.000Z",
    ...(options.starter === undefined ? {} : { starter: options.starter }),
  };
}

const commentOn = (issueNumber: number, stepName = `comment-${issueNumber}`): TaskEffectProposalV1 => ({
  stepName,
  kind: "issue.comment.create",
  payload: { issueNumber, expectedIssueState: "open", expectedIssueUpdatedAt: "2026-10-20T12:00:00.000Z", body: "Thanks." },
  references: {},
  rationale: "Reply.",
} as TaskEffectProposalV1);
const rerun = {
  stepName: "rerun",
  kind: "check.rerun",
  payload: { checkRunId: "77", expectedHeadSha: COMMIT, expectedStatus: "completed", expectedConclusion: "failure" },
  references: {},
  rationale: "Flaky.",
} as TaskEffectProposalV1;
const createIssue = {
  stepName: "create",
  kind: "issue.create",
  payload: { title: "Follow-up", body: "More." },
  references: {},
  rationale: "Track it.",
} as TaskEffectProposalV1;
const commentOnCreated = {
  stepName: "comment-created",
  kind: "issue.comment.create",
  payload: { expectedIssueState: "open", expectedIssueUpdatedAt: "2026-10-20T12:00:00.000Z", body: "Started." },
  references: { "/issueNumber": { step: "create", output: "issueNumber" } },
  rationale: "Note it.",
} as unknown as TaskEffectProposalV1;

function outcome(request: TaskRunRequestV1, proposedEffects: readonly TaskEffectProposalV1[]): CompletedTaskOutcomeV1 {
  return {
    schemaVersion: "gardener.task-outcome/v1",
    runId: request.runId,
    taskId: request.bundle.taskId,
    bundleHash: request.bundleHash,
    status: "completed",
    summary: "Done.",
    observations: [],
    proposedEffects: [...proposedEffects],
  };
}

describe("effect scope", () => {
  it("is the repository only for a trusted starter on a task that does not force trigger scope", async () => {
    expect(runEffectScope(await runRequest({ starter: TRUSTED }))).toBe("repository");
    expect(runEffectScope(await runRequest({ starter: OUTSIDER }))).toBe("trigger");
    // A request admitted before starters existed has none, which means untrusted.
    expect(runEffectScope(await runRequest())).toBe("trigger");
    expect(runEffectScope(await runRequest({ starter: TRUSTED, effectScope: "trigger" }))).toBe("trigger");
  });

  it("refuses a proposal outside the trigger as it arrives, saying why the run is confined", async () => {
    const outsider = await runRequest({ starter: OUTSIDER });
    expect(proposalAuthorityRefusal(outsider, commentOn(1), [])).toBeUndefined();
    expect(proposalAuthorityRefusal(outsider, commentOn(2), []))
      .toBe("issue.comment.create may act only on issue #1, which triggered this run: this run is confined to what triggered it (confined because the author who started it is not a maintainer)");
    expect(proposalAuthorityRefusal(outsider, rerun, [])).toMatch(/^check\.rerun is not allowed: .*\(confined because the author who started it is not a maintainer\)$/);
    expect(proposalAuthorityRefusal(await runRequest({ starter: BOT }), commentOn(2), [])).toMatch(/confined because a bot started it\)$/);
    expect(proposalAuthorityRefusal(await runRequest(), commentOn(2), [])).toMatch(/confined because it was admitted before Gardener recorded who started runs\)$/);
    expect(proposalAuthorityRefusal(await runRequest({ starter: TRUSTED, effectScope: "trigger" }), commentOn(2), []))
      .toMatch(/confined because the task sets effect-scope: trigger\)$/);
    // Trusted starters keep today's repository scope.
    const trusted = await runRequest({ starter: TRUSTED });
    expect(proposalAuthorityRefusal(trusted, commentOn(2), [])).toBeUndefined();
    expect(proposalAuthorityRefusal(trusted, rerun, [])).toBeUndefined();
  });

  it("lets a confined run act on what it created earlier in the same plan", async () => {
    const outsider = await runRequest({ starter: OUTSIDER });
    expect(proposalAuthorityRefusal(outsider, createIssue, [])).toBeUndefined();
    expect(proposalAuthorityRefusal(outsider, commentOnCreated, [createIssue])).toBeUndefined();
    expect(proposalAuthorityRefusal(outsider, commentOnCreated, [])).toMatch(/only from an earlier step of this plan that created it/);
  });

  it("checks scope again when the plan is built, whether or not the plan carries it", async () => {
    for (const options of [
      { starter: OUTSIDER },
      { starter: OUTSIDER, jobWorkflowRef: OLD_PIN },
      {},
      { starter: TRUSTED, effectScope: "trigger" as const, jobWorkflowRef: OLD_PIN },
    ]) {
      const request = await runRequest(options);
      await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [commentOn(1), commentOn(2)]) }))
        .rejects.toThrow("issue.comment.create may act only on issue #1");
      await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [rerun]) })).rejects.toThrow(/check\.rerun is not allowed/);
      await expect(buildTaskEffectPlan({ request, outcome: outcome(request, [createIssue, commentOnCreated]) })).resolves.toBeDefined();
    }
    const trusted = await runRequest({ starter: TRUSTED });
    await expect(buildTaskEffectPlan({ request: trusted, outcome: outcome(trusted, [commentOn(2), rerun]) })).resolves.toBeDefined();
  });

  it("puts the scope in the plan for apply to re-check, except for older pins and requests without a starter", async () => {
    const plan = async (options: Parameters<typeof runRequest>[0]) => {
      const request = await runRequest(options);
      return buildTaskEffectPlan({ request, outcome: outcome(request, [commentOn(1)]) });
    };
    expect((await plan({ starter: OUTSIDER })).effectScope).toBe("trigger");
    expect((await plan({ starter: TRUSTED })).effectScope).toBe("repository");
    expect((await plan({ starter: TRUSTED, effectScope: "trigger" })).effectScope).toBe("trigger");
    // Apply on 0.1.16 and earlier parses plans strictly, so the field would break every run.
    expect(await plan({ starter: OUTSIDER, jobWorkflowRef: OLD_PIN })).not.toHaveProperty("effectScope");
    expect(await plan({ starter: TRUSTED, jobWorkflowRef: OLD_PIN })).not.toHaveProperty("effectScope");
    // A run admitted before this release keeps the plan bytes it already published.
    expect(await plan({})).not.toHaveProperty("effectScope");
  });

  it("tells the model its scope in the prompt", async () => {
    const prompt = async (options: Parameters<typeof runRequest>[0]) => (await createTaskHarnessRequest(await runRequest(options))).prompt;
    expect(await prompt({ starter: OUTSIDER })).toContain(
      "Scope: this run is confined to what triggered it because the author who started it is not a maintainer; steps may act only on issue #1, or on something an earlier step of this run creates. release.update, release.publish, release.delete and check.rerun are refused.",
    );
    expect(await prompt({ starter: TRUSTED })).toContain(
      "Scope: this run may act on any issue, pull request or discussion in the repository, within the effects above.",
    );
    expect(await prompt({ starter: TRUSTED })).not.toContain("confined");
  });
});
