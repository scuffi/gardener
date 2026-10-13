/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake GitHub (gh) and D1 (wrangler) that answer every poll on its first
// attempt, so no test sleeps and none reaches the network.
const mocks = vi.hoisted(() => ({
  resolveInstallation: vi.fn(),
  readProjectLock: vi.fn(),
  setRepositoryEnabled: vi.fn(),
  runCommand: vi.fn(),
  wrangler: vi.fn(),
}));
vi.mock("../src/actions-installation", () => ({
  resolveInstallation: mocks.resolveInstallation,
  readProjectLock: mocks.readProjectLock,
}));
vi.mock("../src/actions-operations", () => ({ setRepositoryEnabled: mocks.setRepositoryEnabled }));
vi.mock("../src/actions-d1", () => ({ isolatedWranglerDirectory: () => "/isolated" }));
vi.mock("../src/commands", () => ({ runCommand: mocks.runCommand, wrangler: mocks.wrangler }));

import { qualifyActions } from "../src/actions-qualify";

const REPOSITORY = "acme/widgets";
const SOURCE_ROOT = "/trusted/gardener";
const BUNDLE_HASH = "b".repeat(64);
const REMEDIATION = `Run: gardener repository enable --workspace demo-team --repository ${REPOSITORY} --source-root ${SOURCE_ROOT}`;
const MARKER = "<!-- gardener-operation:op_1 -->";

type Kind = "qualify" | "negative" | "cancellation";
interface Issue { number: number; kind: Kind; runId: number }
interface Comment { id?: unknown; html_url?: unknown; body?: unknown; user?: { login?: unknown } }

function lockWith(bundle: Record<string, unknown> = {
  triggers: [{ kind: "github.issue.opened", labelsAll: ["gardener-bug"] }],
}) {
  return {
    tasks: {
      "bug-intake": {
        source: "tasks/bug-intake/TASK.md",
        bundleHash: BUNDLE_HASH,
        workflow: ".github/workflows/gardener-bug-intake.yml",
        bundle,
        deployment: {},
      },
    },
  };
}

const commentUrl = (issue: Issue) => `https://github.com/${REPOSITORY}/issues/${issue.number}#issuecomment-${9000 + issue.number}`;

function markedComment(issue: Issue): Comment {
  return { id: 9000 + issue.number, html_url: commentUrl(issue), body: `Done.\n${MARKER}`, user: { login: "github-actions[bot]" } };
}

function receiptFor(issue: Issue, outputs: Record<string, unknown> = {}, bundleHash = BUNDLE_HASH) {
  return {
    schemaVersion: "gardener.runner.effect-receipt/v1",
    planRunId: "plan-run-1",
    bundleHash,
    artifactSha256: "a".repeat(64),
    plannedOperations: 1,
    status: "applied",
    stoppedAtStep: null,
    operations: [{
      stepName: "comment",
      receipt: {
        schemaVersion: "v2",
        operationId: "run:1:step:1:comment",
        operationHash: "c".repeat(64),
        kind: "issue.comment.create",
        status: "succeeded",
        attempt: 1,
        attemptedAt: "2026-10-13T10:00:00.000Z",
        completedAt: "2026-10-13T10:00:01.000Z",
        resourceUrl: commentUrl(issue),
      },
      outputs: { commentId: String(9000 + issue.number), commentUrl: commentUrl(issue), ...outputs },
    }],
  };
}

/** What the fake world answers; each test overrides what it is about. */
let world: {
  issues: Issue[];
  /** The D1 rows recorded for the negative drill's run. */
  negativeRows: Array<Record<string, unknown>>;
  cancelled: Set<number>;
  comments: (issue: Issue) => Comment[];
  conclusion: (issue: Issue) => string;
  /** The raw `wrangler d1 execute --json` value for a qualify run's receipt query. */
  receiptRows: (issue: Issue) => unknown;
  /** Per successful run, the audit events counted for it. */
  events: (runId: string) => Array<Record<string, unknown>>;
  onRunList: (issue: Issue) => void;
};

function resetWorld() {
  world = {
    issues: [],
    negativeRows: [{ status: "rejected", effect_receipt_json: null }],
    cancelled: new Set(),
    comments: (issue) => issue.kind === "qualify" ? [markedComment(issue)] : [],
    conclusion: (issue) => ({ qualify: "success", negative: "failure", cancellation: "cancelled" })[issue.kind],
    receiptRows: (issue) => [
      null,
      { results: "not rows" },
      { results: [null, 5, { bundle_hash: BUNDLE_HASH, effect_receipt_json: JSON.stringify(receiptFor(issue)) }] },
    ],
    events: (runId) => [
      { github_run_id: runId, github_run_attempt: 1, event: "effect.executed", event_count: 1 },
      { github_run_id: runId, github_run_attempt: 1, event: "task.settled", event_count: 1 },
    ],
    onRunList: () => undefined,
  };
}

const byRun = (runId: string) => world.issues.find((issue) => String(issue.runId) === runId)!;

function gh(args: string[]): string {
  const [command, subcommand] = args;
  if (command === "label" && subcommand === "create") return "";
  if (command === "issue" && subcommand === "create") {
    const title = args[args.indexOf("--title") + 1]!;
    const kind: Kind = title.includes("negative admission") ? "negative" : title.includes("cancellation") ? "cancellation" : "qualify";
    const number = world.issues.length + 1;
    world.issues.push({ number, kind, runId: 5000 + number });
    return `Creating issue in ${REPOSITORY}\n\nhttps://github.com/${REPOSITORY}/issues/${number}\n`;
  }
  if (command === "run" && subcommand === "list") {
    const latest = world.issues.at(-1)!;
    world.onRunList(latest);
    return JSON.stringify([{ databaseId: latest.runId, url: `https://github.com/${REPOSITORY}/actions/runs/${latest.runId}`, createdAt: "9999-12-31T00:00:00.000Z" }]);
  }
  if (command === "run" && subcommand === "view") {
    return JSON.stringify({ status: "completed", conclusion: world.conclusion(byRun(args[2]!)) });
  }
  if (command === "api" && args.includes("--method")) {
    const runId = /actions\/runs\/(\d+)\/force-cancel$/.exec(args.at(-1)!)![1]!;
    world.cancelled.add(Number(runId));
    return "";
  }
  if (command === "api") {
    const number = Number(/issues\/(\d+)\/comments$/.exec(subcommand!)![1]);
    return JSON.stringify(world.comments(world.issues.find((issue) => issue.number === number)!));
  }
  throw new Error(`Unexpected gh ${args.join(" ")}`);
}

function d1(statement: string): unknown {
  const runId = /github_run_id='(\d+)'/.exec(statement)?.[1];
  if (statement.startsWith("SELECT bundle_hash,effect_receipt_json")) return world.receiptRows(byRun(runId!));
  if (statement.startsWith("SELECT github_run_id FROM actions_task_runs")) return [{ results: [{ github_run_id: "4242" }] }];
  if (statement.startsWith("SELECT r.github_run_id")) {
    const runs = [...statement.matchAll(/'(\d+)'/g)].map((match) => match[1]!);
    return [{ results: runs.flatMap((id) => world.events(id)) }];
  }
  if (statement.startsWith("SELECT status,effect_receipt_json")) {
    const issue = byRun(runId!);
    if (issue.kind === "negative") return [{ results: world.negativeRows }];
    return [{ results: [{ status: world.cancelled.has(issue.runId) ? "cancelled" : "running", effect_receipt_json: null }] }];
  }
  throw new Error(`Unexpected D1 statement ${statement}`);
}

const qualify = (input: { drills?: boolean; drillsOnly?: boolean } = {}) => qualifyActions({
  workspace: "demo-team",
  repository: REPOSITORY,
  repositoryRoot: "/checkout",
  sourceRoot: SOURCE_ROOT,
  ...input,
});

const ghCalls = (command: string, subcommand: string) =>
  mocks.runCommand.mock.calls.filter(([, args]) => args[0] === command && args[1] === subcommand);
const enabledCalls = () => mocks.setRepositoryEnabled.mock.calls.map(([input]) => input.enabled);
const signalListeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

const savedTokens = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CF_API_TOKEN: process.env.CF_API_TOKEN };
beforeEach(() => {
  resetWorld();
  // Without a token the D1 polls go through wrangler, never fetch.
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in tests"); }));
  mocks.resolveInstallation.mockResolvedValue({
    workspace: "demo-team",
    cloudflare: {
      accountId: "account-1",
      database: { name: "gardener-demo-team", id: "11111111-1111-4111-8111-111111111111" },
      runtimeWorker: "gardener-demo-team",
      runtimeOrigin: "https://runner.example.workers.dev",
    },
    cliVersion: "0.1.2",
    deploymentHash: null,
    deployedAt: null,
    aiGateway: null,
  });
  mocks.readProjectLock.mockResolvedValue(lockWith());
  mocks.setRepositoryEnabled.mockImplementation(async (input: { enabled: boolean }) => ({ repositoryId: "101", enabled: input.enabled }));
  mocks.runCommand.mockImplementation((command: string, args: string[]) => {
    if (command !== "gh") throw new Error(`Unexpected command ${command}`);
    return { status: 0, stdout: gh(args), stderr: "" };
  });
  mocks.wrangler.mockImplementation((_root: string, _cwd: string, args: string[]) => {
    expect(args.slice(0, 5)).toEqual(["d1", "execute", "gardener-demo-team", "--remote", "--json"]);
    return { status: 0, stdout: JSON.stringify(d1(args.at(-1)!)), stderr: "" };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
  for (const [key, value] of Object.entries(savedTokens)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("qualifyActions", () => {
  it("refuses --drills-only without --drills before touching GitHub", async () => {
    await expect(qualify({ drillsOnly: true })).rejects.toThrow("--drills-only requires --drills");
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.setRepositoryEnabled).not.toHaveBeenCalled();
  });

  it("refuses a task with no issue-opened qualification label", async () => {
    for (const bundle of [
      { triggers: [{ kind: "github.workflow_dispatch" }] },
      { triggers: [{ kind: "github.issue.opened", labelsAll: [] }] },
      {},
    ]) {
      mocks.readProjectLock.mockResolvedValue(lockWith(bundle));
      await expect(qualify()).rejects.toThrow("Task bug-intake has no issue-opened qualification label");
      // The drills check the same, before disabling the repository.
      await expect(qualify({ drills: true, drillsOnly: true })).rejects.toThrow("Task bug-intake has no issue-opened qualification label");
    }
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.setRepositoryEnabled).not.toHaveBeenCalled();
  });

  it("reports the comment the D1 receipt and GitHub agree on, ignoring malformed D1 rows", async () => {
    const report = await qualify();
    expect(report).toMatchObject({
      schemaVersion: "gardener.actions-qualification/v1",
      workspace: "demo-team",
      repository: REPOSITORY,
      tasks: [{
        taskId: "bug-intake",
        label: "gardener-bug",
        issueNumber: 1,
        issueUrl: `https://github.com/${REPOSITORY}/issues/1`,
        runId: "5001",
        commentId: "9001",
        commentUrl: `https://github.com/${REPOSITORY}/issues/1#issuecomment-9001`,
        bundleHash: BUNDLE_HASH,
      }],
    });
    expect(report.drills).toBeUndefined();
    expect(mocks.setRepositoryEnabled).not.toHaveBeenCalled();
  });

  it("refuses anything but exactly one marked comment from github-actions[bot]", async () => {
    world.comments = (issue) => [markedComment(issue), { ...markedComment(issue), id: 1 }];
    await expect(qualify()).rejects.toThrow("Task bug-intake produced 2 marked comments instead of one");
    world.comments = (issue) => [
      { ...markedComment(issue), user: { login: "mallory" } },
      { ...markedComment(issue), body: "no marker" },
    ];
    await expect(qualify()).rejects.toThrow("Task bug-intake produced 0 marked comments instead of one");
  });

  it("refuses a run with no unique persisted receipt", async () => {
    for (const rows of [
      { results: [] },
      [{ results: [] }],
      [{ results: [{ bundle_hash: BUNDLE_HASH, effect_receipt_json: "{}" }, { bundle_hash: BUNDLE_HASH, effect_receipt_json: "{}" }] }],
      [{ results: [{ bundle_hash: BUNDLE_HASH, effect_receipt_json: null }] }],
    ]) {
      world.receiptRows = () => rows;
      await expect(qualify()).rejects.toThrow("Task bug-intake has no unique persisted effect receipt");
    }
  });

  it("refuses a receipt whose comment differs from the GitHub one", async () => {
    for (const outputs of [{ commentId: "1234" }, { commentUrl: `https://github.com/${REPOSITORY}/issues/1#issuecomment-1234` }]) {
      world.receiptRows = (issue) => [{ results: [{ bundle_hash: BUNDLE_HASH, effect_receipt_json: JSON.stringify(receiptFor(issue, outputs)) }] }];
      await expect(qualify()).rejects.toThrow("Task bug-intake D1 receipt does not match the GitHub comment");
    }
  });

  it("refuses a receipt for another bundle than the compiled one", async () => {
    world.receiptRows = (issue) => [{ results: [{ bundle_hash: "d".repeat(64), effect_receipt_json: JSON.stringify(receiptFor(issue)) }] }];
    await expect(qualify()).rejects.toThrow("Task bug-intake D1 receipt does not match the compiled bundle");
    world.receiptRows = (issue) => [{ results: [{ bundle_hash: BUNDLE_HASH, effect_receipt_json: JSON.stringify(receiptFor(issue, {}, "d".repeat(64))) }] }];
    await expect(qualify()).rejects.toThrow("Task bug-intake D1 receipt does not match the compiled bundle");
  });
});

describe("qualifyFailureDrills", () => {
  it("disables the repository for the negative drill, re-enables it, then cancels and reconciles", async () => {
    const listeners = signalListeners();
    const report = await qualify({ drills: true });
    expect(report.drills).toEqual({
      negativeAdmission: { taskId: "bug-intake", issueNumber: 2, runId: "5002", rejected: true },
      cancellation: { taskId: "bug-intake", issueNumber: 3, runId: "5003", status: "cancelled" },
      reconciliation: { runsVerified: 1, duplicateSettlementEvents: 0, duplicateEffectEvents: 0 },
    });
    expect(mocks.setRepositoryEnabled.mock.calls.map(([input]) => input)).toEqual([
      { workspace: "demo-team", repository: REPOSITORY, sourceRoot: SOURCE_ROOT, enabled: false },
      { workspace: "demo-team", repository: REPOSITORY, sourceRoot: SOURCE_ROOT, enabled: true },
    ]);
    expect(ghCalls("api", "--method")).toHaveLength(1);
    expect(signalListeners()).toEqual(listeners);
  });

  it("reconciles the latest recorded runs when only the drills run", async () => {
    const report = await qualify({ drills: true, drillsOnly: true });
    expect(report.tasks).toEqual([]);
    expect(report.drills?.reconciliation.runsVerified).toBe(1);
    expect(enabledCalls()).toEqual([false, true]);
  });

  it("refuses a run without exactly one settlement and effect event", async () => {
    world.events = (runId) => [
      { github_run_id: runId, event: "effect.executed", event_count: 1 },
      { github_run_id: runId, event: "task.settled", event_count: 2 },
    ];
    await expect(qualify({ drills: true })).rejects.toThrow("Run 5001 does not have one reconciled settlement and effect event");
  });

  it("re-enables the repository when the negative drill throws", async () => {
    const listeners = signalListeners();
    // A disabled repository's run must not succeed; this one does.
    world.conclusion = () => "success";
    await expect(qualify({ drills: true })).rejects.toThrow("GitHub run 5002 unexpectedly succeeded");
    expect(enabledCalls()).toEqual([false, true]);
    // Nothing after the negative drill ran.
    expect(world.issues.map((issue) => issue.kind)).toEqual(["qualify", "negative"]);
    expect(signalListeners()).toEqual(listeners);
  });

  it("re-enables the repository when the disabled repository still produced a comment", async () => {
    world.comments = (issue) => [markedComment(issue)];
    await expect(qualify({ drills: true })).rejects.toThrow("Task bug-intake failure drill unexpectedly produced a marked comment");
    expect(enabledCalls()).toEqual([false, true]);
  });

  it("re-enables the repository when the disabled repository's run completed or recorded a receipt", async () => {
    for (const row of [{ status: "completed", effect_receipt_json: null }, { status: "rejected", effect_receipt_json: "{}" }]) {
      world.issues = [];
      mocks.setRepositoryEnabled.mockClear();
      world.negativeRows = [{ status: "rejected", effect_receipt_json: null }, row];
      await expect(qualify({ drills: true })).rejects.toThrow("Disabled repository produced a completed run or effect receipt");
      expect(enabledCalls()).toEqual([false, true]);
    }
  });

  it("reports the repository enable remediation when the restore fails, keeping the drill's error as the cause", async () => {
    const listeners = signalListeners();
    const restoreError = new Error("D1 unavailable");
    mocks.setRepositoryEnabled.mockImplementation(async (input: { enabled: boolean }) => {
      if (input.enabled) throw restoreError;
      return { repositoryId: "101", enabled: false };
    });
    world.conclusion = () => "success";
    const failure = await qualify({ drills: true }).then(() => { throw new Error("qualified"); }, (error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(`Failed to re-enable repository ${REPOSITORY} after the negative drill. ${REMEDIATION}`);
    expect((failure.cause as Error).message).toBe("GitHub run 5002 unexpectedly succeeded");
    expect(signalListeners()).toEqual(listeners);
  });

  it("reports the remediation when only the restore fails, and stops before the cancellation drill", async () => {
    const restoreError = new Error("D1 unavailable");
    mocks.setRepositoryEnabled.mockImplementation(async (input: { enabled: boolean }) => {
      if (input.enabled) throw restoreError;
      return { repositoryId: "101", enabled: false };
    });
    const failure = await qualify({ drills: true }).then(() => { throw new Error("qualified"); }, (error: unknown) => error as Error);
    expect(failure.message).toBe(`Failed to re-enable repository ${REPOSITORY} after the negative drill. ${REMEDIATION}`);
    expect(failure.cause).toBe(restoreError);
    expect(world.issues.map((issue) => issue.kind)).toEqual(["qualify", "negative"]);
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("restores the repository once and exits %s with %i when interrupted", async (signal, exitCode) => {
    const before = process.listeners(signal);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    world.onRunList = (issue) => {
      if (issue.kind !== "negative") return;
      const added = process.listeners(signal).filter((listener) => !before.includes(listener));
      expect(added).toHaveLength(1);
      (added[0] as () => void)();
    };
    // The interrupted drill then fails, as the process would have exited.
    world.conclusion = () => "success";
    await expect(qualify({ drills: true })).rejects.toThrow("unexpectedly succeeded");
    expect(error).toHaveBeenCalledWith(`Qualification interrupted while repository ${REPOSITORY} is disabled. ${REMEDIATION}`);
    expect(exit).toHaveBeenCalledWith(exitCode);
    // The signal's restore and the finally share one re-enable.
    expect(enabledCalls()).toEqual([false, true]);
    expect(process.listeners(signal)).toEqual(before);
  });
});
