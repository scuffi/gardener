import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "@gardener/core";
import { eventNameByTriggerKind, type NormalizedEventV1, type TaskRunRequestV1 } from "@gardener/contracts";
import { runnerActionV1Schema, type RunnerHelloV1 } from "@gardener/protocol";
import {
  CAPTURE_KEY,
  CAPTURE_PENDING_KEY,
  OIDC_PREFIX,
  assertCaptureAdmissible,
  assertCaptureNotStarted,
  assertEffectPlanBoundToHello,
  assertReportedEventMatchesOidc,
  assertRunnerMayRequest,
  assertSingleCaptureConsumer,
  consumeOidcTokenIn,
} from "../src/task-runtime/session-checks";
import { inspectRepositoryFixtureBundle } from "./fixture-bundle";
import { MemoryStorage } from "./memory-storage";

/**
 * The Worker-side trust boundary of `TaskRunnerSession`. `session.ts` imports
 * `cloudflare:workers` and cannot load under vitest, so its decisions live in
 * `session-checks.ts` and are exercised here directly; the session supplies
 * the Durable Object storage transaction.
 */
const COMMIT = "a".repeat(40);
const OPERATION = `op_${"1".repeat(64)}`;

const workflow = {
  runId: "35256179260",
  runAttempt: 2,
  workflowRef: "scuffi/demo/.github/workflows/gardener.yml@refs/heads/main",
  jobWorkflowRef: `scuffi/demo/.github/workflows/gardener-task.yml@${"c".repeat(40)}`,
  runnerEnvironment: "github-hosted" as const,
};

const repository = {
  id: "1374842705",
  ownerId: "45369682",
  owner: "scuffi",
  name: "demo",
  fullName: "scuffi/demo",
  visibility: "public" as const,
  commitSha: COMMIT,
  ref: "refs/heads/main",
  defaultBranch: "main",
};

function issueEvent(): NormalizedEventV1 {
  return {
    schemaVersion: "gardener.normalized-event/v1",
    eventId: "event:1",
    occurredAt: "2026-09-17T12:00:00.000Z",
    kind: "github.issue.opened",
    repository,
    workflow: { ...workflow, eventName: "issues" },
    actor: { id: "45369682", login: "scuffi" },
    issue: { id: "999", number: 1, title: "Bug", body: "Broken", state: "open", updatedAt: "2026-09-17T12:00:00.000Z", labels: [], author: { id: "45369682", login: "scuffi" } },
  };
}

async function runRequest(): Promise<TaskRunRequestV1> {
  const bundle = inspectRepositoryFixtureBundle();
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
  } as TaskRunRequestV1;
}

/** The effects hello that exactly matches `runRequest()`. */
function effectsHello(request: TaskRunRequestV1): RunnerHelloV1 {
  return {
    schemaVersion: "gardener.runner.hello/v1",
    protocolVersion: "gardener.runner.rpc/v1",
    phase: "effects",
    repositoryId: repository.id,
    ownerId: repository.ownerId,
    runId: workflow.runId,
    runAttempt: workflow.runAttempt,
    workflowRef: workflow.workflowRef,
    jobWorkflowRef: workflow.jobWorkflowRef,
    eventName: "issues",
    ref: repository.ref,
    runnerEnvironment: "github-hosted",
    commitSha: COMMIT,
    agentHash: request.bundleHash,
  };
}

describe("OIDC token replay", () => {
  it("accepts a token once, records its expiry, and refuses its replay", async () => {
    const storage = new MemoryStorage();
    await consumeOidcTokenIn(storage, "jti-1", 1_800_000_000);
    expect(storage.values.get(`${OIDC_PREFIX}jti-1`)).toBe(1_800_000_000);
    await expect(consumeOidcTokenIn(storage, "jti-1", 1_800_000_000)).rejects.toThrow("OIDC token was already used");
    await expect(consumeOidcTokenIn(storage, "jti-1", 1_900_000_000)).rejects.toThrow("OIDC token was already used");
    // The refusal leaves the first record untouched.
    expect(storage.values.get(`${OIDC_PREFIX}jti-1`)).toBe(1_800_000_000);
  });

  it("keeps different tokens independent", async () => {
    const storage = new MemoryStorage();
    await consumeOidcTokenIn(storage, "jti-1", 1);
    await expect(consumeOidcTokenIn(storage, "jti-2", 1)).resolves.toBeUndefined();
  });
});

describe("runner-requested actions", () => {
  it("refuses repository.capture, which only the runtime issues", () => {
    const capture = runnerActionV1Schema.parse({
      schemaVersion: "gardener.runner.action/v1",
      sequence: 1,
      operationId: OPERATION,
      kind: "repository.capture",
      timeoutMs: 1_000,
      baseSha: COMMIT,
      maxOutputBytes: 1_024,
    });
    expect(() => assertRunnerMayRequest(capture)).toThrow("Repository capture cannot be requested by the runner");
  });

  it("lets every other action kind through to the declared-tool checks", () => {
    const base = { schemaVersion: "gardener.runner.action/v1", sequence: 1, operationId: OPERATION, timeoutMs: 1_000 };
    for (const action of [
      { ...base, kind: "shell.exec", command: "ls", cwd: "/workspace", maxOutputBytes: 1_024 },
      { ...base, kind: "github.read", request: { transport: "rest", method: "GET", path: "/x" }, maxOutputBytes: 1_024 },
      { ...base, kind: "repository.merge_base" },
    ]) {
      expect(() => assertRunnerMayRequest(runnerActionV1Schema.parse(action))).not.toThrow();
    }
  });
});

describe("reported event versus the signed OIDC event name", () => {
  it("accepts every trigger kind with its own event name", () => {
    for (const [kind, eventName] of Object.entries(eventNameByTriggerKind)) {
      expect(() => assertReportedEventMatchesOidc(kind as keyof typeof eventNameByTriggerKind, eventName)).not.toThrow();
    }
  });

  it("refuses a payload whose kind belongs to another event", () => {
    expect(() => assertReportedEventMatchesOidc("github.discussion.created", "issues")).toThrow(
      "Reported event github.discussion.created does not match the issues event in the verified OIDC claims",
    );
    expect(() => assertReportedEventMatchesOidc("github.issue_comment.created", "issues")).toThrow(/does not match the issues event/);
    expect(() => assertReportedEventMatchesOidc("github.workflow_dispatch", "push")).toThrow(/does not match the push event/);
  });
});

describe("effect plan binding to the effects hello", () => {
  const message = "Effect plan is not bound to this repository workflow run and attempt";

  it("accepts the matching hello and a later attempt of the same run", async () => {
    const request = await runRequest();
    expect(() => assertEffectPlanBoundToHello(request, effectsHello(request))).not.toThrow();
    expect(() => assertEffectPlanBoundToHello(request, { ...effectsHello(request), runAttempt: 3 })).not.toThrow();
  });

  it.each([
    ["runId", { runId: "35256179261" }],
    ["runAttempt older than the plan", { runAttempt: 1 }],
    ["repositoryId", { repositoryId: "1374842706" }],
    ["commitSha", { commitSha: "b".repeat(40) }],
    ["workflowRef", { workflowRef: "scuffi/demo/.github/workflows/other.yml@refs/heads/main" }],
    ["eventName", { eventName: "issue_comment" }],
    ["agentHash", { agentHash: "e".repeat(64) }],
  ] as const)("refuses a mismatched %s", async (_field, change) => {
    const request = await runRequest();
    expect(() => assertEffectPlanBoundToHello(request, { ...effectsHello(request), ...change })).toThrow(message);
  });
});

describe("capture-pending barrier", () => {
  const proposalMessage = "The working tree capture has started; no further effect proposal may be admitted";

  it("admits proposals and actions while no capture has started", async () => {
    await expect(assertCaptureNotStarted(new MemoryStorage(), proposalMessage)).resolves.toBeUndefined();
  });

  it("refuses once a capture is pending", async () => {
    const storage = new MemoryStorage();
    await storage.put(CAPTURE_PENDING_KEY, { operationId: OPERATION, runId: "run:fixture:1", generation: 0 });
    await expect(assertCaptureNotStarted(storage, proposalMessage)).rejects.toThrow(proposalMessage);
  });

  it("refuses once a capture is admitted", async () => {
    const storage = new MemoryStorage();
    await storage.put(CAPTURE_KEY, { ack: {} });
    await expect(assertCaptureNotStarted(storage, "no further repository action may run")).rejects.toThrow("no further repository action may run");
  });

  it("lets only the same capture attempt in the same generation mark itself pending", () => {
    const pending = { operationId: OPERATION, runId: "run:fixture:1", generation: 0 };
    expect(() => assertCaptureAdmissible(0, 0, undefined, OPERATION)).not.toThrow();
    expect(() => assertCaptureAdmissible(0, 0, pending, OPERATION)).not.toThrow();
    expect(() => assertCaptureAdmissible(0, 0, pending, `op_${"2".repeat(64)}`)).toThrow("Repository capture admission conflict");
    expect(() => assertCaptureAdmissible(1, 0, undefined, OPERATION)).toThrow("Repository capture generation changed; retry capture admission");
    // The generation is checked first.
    expect(() => assertCaptureAdmissible(1, 0, pending, `op_${"2".repeat(64)}`)).toThrow(/generation changed/);
  });

  it("captures only for exactly one consuming step", () => {
    expect(() => assertSingleCaptureConsumer([])).toThrow("No proposed step materializes repository changes, so there is nothing to capture");
    expect(() => assertSingleCaptureConsumer([{ stepName: "commit" }])).not.toThrow();
    expect(() => assertSingleCaptureConsumer([{ stepName: "one" }, { stepName: "two" }])).toThrow(
      "Steps one, two each materialize repository changes, but a run captures the working tree once",
    );
  });
});

describe("session wiring", () => {
  // The checks above only protect the boundary while the session still calls them.
  const source = readFileSync(new URL("../src/task-runtime/session.ts", import.meta.url), "utf8");

  it("calls each extracted check at its call site", () => {
    expect(source).toMatch(/await this\.ctx\.storage\.transaction\(\(transaction\) => consumeOidcTokenIn\(transaction, jti, expiresAt\)\);/);
    expect(source).toMatch(/await this\.consumeOidcToken\(actor\.jti, actor\.expiresAt\);/);
    expect(source).toMatch(/const action = runnerActionV1Schema\.parse\(input\);\n[^\n]*\n    assertRunnerMayRequest\(action\);/);
    expect(source).toMatch(/assertEffectPlanBoundToHello\(request, identity\.hello\);/);
    expect(source).toMatch(/assertReportedEventMatchesOidc\(runnerEvent\.kind, identity\.hello\.eventName\);/);
    expect(source).toMatch(/await assertCaptureNotStarted\(transaction, "The working tree capture has started; no further effect proposal may be admitted"\);/);
    // invoke and reserveRunnerToolBudget both hold the action barrier.
    expect(source.match(/await assertCaptureNotStarted\(transaction, "The working tree capture has started; no further repository action may run"\);/g)).toHaveLength(2);
    expect(source).toMatch(/const current = await transaction\.get<AdmittedTaskCaptureV1>\(CAPTURE_KEY\);\n      if \(current\) return;\n(?:      \/\/[^\n]*\n)*      assertCaptureAdmissible\(\n        await transaction\.get<number>\(CAPTURE_GENERATION_KEY\) \?\? 0,\n        generation,\n        await transaction\.get<CapturePending>\(CAPTURE_PENDING_KEY\),\n        operationId,\n      \);/);
    // The runtime's own capture is exempt from the action barrier; every other action is held by it.
    expect(source).toMatch(/if \(action\.kind !== "repository\.capture"\) \{\n        await assertCaptureNotStarted\(transaction, "The working tree capture has started; no further repository action may run"\);\n      \}/);
    // toolAction, the gate between model JSON and the runner's shell, runs only after the session-state checks.
    const reserve = source.indexOf("await this.reserveRunnerToolBudgetCountingRefusal(invocation.runId, operationId);");
    const build = source.indexOf("const action = toolAction(sequence, operationId, invocation);");
    expect(reserve).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(reserve);
    expect(source.match(/toolAction\(/g)).toHaveLength(1);
    expect(source).toMatch(/assertSingleCaptureConsumer\(consumers\);/);
  });
});
