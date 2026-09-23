import { beforeEach, describe, expect, it } from "vitest";
import { taskEffectProposalV1Schema, type TaskEffectProposalV1 } from "@gardener/contracts";
import {
  PROPOSAL_COUNT_KEY,
  RUNNER_TOOL_COUNT_KEY,
  admitProposal,
  proposalDigest,
  readProposalLedger,
  recordedProposalIndex,
  type ProposalLedgerStorage,
} from "../src/task-runtime/effect-plan";

const RUN_ID = "run:fixture:1";
const COMMIT = "b".repeat(40);
const ISSUE_PRECONDITIONS = {
  issueNumber: 1,
  expectedIssueState: "open",
  expectedIssueUpdatedAt: "2026-09-17T12:00:00.000Z",
} as const;

/**
 * In-memory stand-in for the slice of Durable Object storage the ledger uses.
 *
 * `transaction` snapshots and restores on throw, because rollback is exactly
 * what the budget guarantees rest on: a refused proposal must leave the tool
 * counter untouched, and a fake that kept partial writes would let that
 * regress silently.
 */
class MemoryStorage implements ProposalLedgerStorage {
  entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> { return this.entries.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.entries.set(key, value); }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.entries.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right)) as [string, T][],
    );
  }

  async transaction<T>(body: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.entries);
    try {
      return await body(this);
    } catch (cause) {
      this.entries = snapshot;
      throw cause;
    }
  }
}

function proposal(value: unknown): TaskEffectProposalV1 {
  return taskEffectProposalV1Schema.parse(value);
}

const comment = proposal({
  stepName: "comment",
  kind: "issue.comment.create",
  payload: { ...ISSUE_PRECONDITIONS, body: "Thanks." },
  rationale: "Acknowledge.",
});

const branch = proposal({
  stepName: "branch",
  kind: "branch.create",
  payload: { branch: "gardener/fix-1", fromSha: COMMIT, expectedAbsent: true },
  rationale: "Work needs a branch.",
});

/** Mirrors the session: digest the effect, then admit under one transaction. */
async function record(storage: MemoryStorage, value: TaskEffectProposalV1, maxToolCalls = 24) {
  const digest = await proposalDigest(RUN_ID, value);
  return storage.transaction((transaction) => admitProposal(transaction, {
    proposal: value,
    digest,
    maxToolCalls,
    recordedToolCalls: async () => (await transaction.list({ prefix: "action:" })).size,
  }));
}

describe("durable ordered proposal ledger", () => {
  let storage: MemoryStorage;

  beforeEach(() => { storage = new MemoryStorage(); });

  it("records proposals in call order and reads them back in that order", async () => {
    expect(await record(storage, branch)).toEqual({ stepName: "branch", index: 0, duplicate: false, totalProposed: 1 });
    expect(await record(storage, comment)).toEqual({ stepName: "comment", index: 1, duplicate: false, totalProposed: 2 });
    expect((await readProposalLedger(storage)).map((entry) => entry.stepName)).toEqual(["branch", "comment"]);
  });

  it("keeps plan order past the point where keys would sort as text", async () => {
    for (let index = 0; index < 12; index += 1) {
      await record(storage, proposal({ ...comment, stepName: `note-${index}`, payload: { ...comment.payload, body: `Note ${index}.` } }));
    }
    expect((await readProposalLedger(storage)).map((entry) => entry.stepName))
      .toEqual(Array.from({ length: 12 }, (_, index) => `note-${index}`));
  });

  it("treats an identical replayed call as the proposal it already holds", async () => {
    await record(storage, comment);
    const digest = await proposalDigest(RUN_ID, comment);

    // This is what a Flue replay hits before the session opens a transaction.
    expect(await recordedProposalIndex(storage, digest)).toBe(0);
    expect(await record(storage, comment)).toEqual({ stepName: "comment", index: 0, duplicate: true, totalProposed: 1 });
    expect(await readProposalLedger(storage)).toHaveLength(1);
    expect(storage.entries.get(PROPOSAL_COUNT_KEY)).toBe(1);
  });

  it("rejects a step name reused for a different effect", async () => {
    await record(storage, comment);
    await expect(record(storage, proposal({ ...comment, payload: { ...comment.payload, body: "Different." } })))
      .rejects.toThrow(/Step name comment was already proposed with different content/);
    expect(await readProposalLedger(storage)).toHaveLength(1);
  });

  it("binds a digest to its run, so another run's identical effect is new", async () => {
    expect(await proposalDigest("run:other:1", comment)).not.toBe(await proposalDigest(RUN_ID, comment));
  });

  it("starts empty, which is a valid plan", async () => {
    expect(await readProposalLedger(storage)).toEqual([]);
    expect(await recordedProposalIndex(storage, await proposalDigest(RUN_ID, comment))).toBeUndefined();
  });
});

describe("effect identity excludes the rationale", () => {
  const reworded = proposal({ ...comment, rationale: "Completely different justification." });

  it("digests the same effect to the same value however it is justified", async () => {
    expect(await proposalDigest(RUN_ID, reworded)).toBe(await proposalDigest(RUN_ID, comment));
  });

  it("acknowledges a reworded repeat as a replay rather than a conflict", async () => {
    const storage = new MemoryStorage();
    await record(storage, comment);
    // The provider call is identical, so this is the model restating itself.
    // Refusing it as a step-name conflict would fail a correct run.
    expect(await record(storage, reworded))
      .toEqual({ stepName: "comment", index: 0, duplicate: true, totalProposed: 1 });
    expect(await readProposalLedger(storage)).toHaveLength(1);
    expect((await readProposalLedger(storage))[0]?.rationale).toBe("Acknowledge.");
  });

  it("still treats a changed payload under the same name as a conflict", async () => {
    const storage = new MemoryStorage();
    await record(storage, comment);
    await expect(record(storage, proposal({ ...reworded, payload: { ...comment.payload, body: "Other." } })))
      .rejects.toThrow(/already proposed with different content/);
  });
});

describe("shared tool budget", () => {
  let storage: MemoryStorage;

  beforeEach(() => { storage = new MemoryStorage(); });

  it("charges one call per admitted proposal", async () => {
    await record(storage, branch);
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(1);
    await record(storage, comment);
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(2);
  });

  it("charges nothing for a replay", async () => {
    await record(storage, comment);
    await record(storage, comment);
    await record(storage, proposal({ ...comment, rationale: "Said another way." }));
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(1);
  });

  it("charges nothing for a refused conflict, so retries are not taxed", async () => {
    await record(storage, comment);
    for (const body of ["one", "two", "three"]) {
      await expect(record(storage, proposal({ ...comment, payload: { ...comment.payload, body } })))
        .rejects.toThrow(/already proposed with different content/);
    }
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(1);
    expect(await readProposalLedger(storage)).toHaveLength(1);
  });

  it("shares one counter with repository actions rather than bootstrapping past them", async () => {
    storage.entries.set("action:op_a", { action: {} });
    storage.entries.set("action:op_b", { action: {} });
    await record(storage, comment);
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(3);
  });

  it("refuses the proposal that would exceed the declared ceiling, and records nothing", async () => {
    await record(storage, comment, 2);
    await expect(record(storage, branch, 2)).rejects.toThrow();
    expect(await readProposalLedger(storage)).toHaveLength(1);
    // The rejected call left the counter where the admitted one put it.
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(1);
  });

  it("charges exactly once when the same effect is admitted concurrently", async () => {
    const [first, second] = await Promise.all([record(storage, comment), record(storage, comment)]);
    expect([first.duplicate, second.duplicate].filter(Boolean)).toHaveLength(1);
    expect(await readProposalLedger(storage)).toHaveLength(1);
    expect(storage.entries.get(RUNNER_TOOL_COUNT_KEY)).toBe(1);
  });
});

describe("proposal contract boundary", () => {
  it("accepts every declared operation kind the model can name", () => {
    expect(() => proposal({ ...branch, stepName: "b" })).not.toThrow();
    expect(() => proposal({ ...comment, kind: "not.a.kind" })).toThrow();
  });

  it("refuses a payload carrying a field the plan owns", () => {
    for (const key of ["schemaVersion", "id", "repository", "kind"]) {
      expect(() => proposal({ ...comment, payload: { ...comment.payload, [key]: "x" } })).toThrow();
    }
  });

  it("refuses an operation id the model tried to choose", () => {
    expect(() => proposal({ ...comment, operationId: "op_chosen" })).toThrow();
  });

  it("refuses a reference pointing at a plan-owned field", () => {
    expect(() => proposal({ ...comment, references: { "/repository": { step: "branch", output: "branch" } } })).toThrow();
  });

  it("refuses repository file bytes the session would otherwise have to trust", () => {
    // This is the boundary `recordProposal` parses at, so it is where the
    // write boundary has to hold: file bytes reach GitHub only from the
    // trusted capture, never from a model tool call. Both routes are closed.
    const commit = {
      stepName: "commit",
      kind: "commit.create",
      payload: { branch: "gardener/fix-1", expectedHeadSha: "c".repeat(40), message: "Fix it." },
      rationale: "Commit the captured change.",
    };
    expect(() => proposal(commit)).not.toThrow();
    expect(() => proposal({
      ...commit,
      payload: { ...commit.payload, files: [{ path: "src/a.ts", contentBase64: "AA==" }] },
    })).toThrow(/may not be supplied by the task/);
    expect(() => proposal({
      ...commit,
      references: { "/files": { step: "earlier", output: "commentUrl" } },
    })).toThrow(/may not be referenced/);
  });
});
