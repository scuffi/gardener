import { describe, expect, it } from "vitest";
import { ActionJournal, type RunnerActionResultV1, type RunnerActionV1 } from "../src";

const action: RunnerActionV1 = {
  schemaVersion: "gardener.runner.action/v1",
  sequence: 1,
  operationId: "op-one",
  kind: "shell.exec",
  command: "pwd",
  cwd: "/workspace",
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
};

const result: RunnerActionResultV1 = {
  schemaVersion: "gardener.runner.action-result/v1",
  sequence: 1,
  operationId: "op-one",
  status: "completed",
  exitCode: 0,
  stdout: "/workspace\n",
  stderr: "",
  outputTruncated: false,
};

describe("ActionJournal", () => {
  it("requires reconciliation instead of replay after an ambiguous execution", () => {
    const journal = new ActionJournal();
    journal.register(action);
    journal.claim(action.operationId);
    journal.markAmbiguous(action.operationId);

    expect(() => journal.claim(action.operationId)).toThrow(/reconciled, not replayed/);
    expect(journal.complete(result)).toMatchObject({ state: "completed", result });
  });

  it("makes identical registration and completion idempotent", () => {
    const journal = new ActionJournal();
    expect(journal.register(action).state).toBe("queued");
    expect(journal.register(structuredClone(action)).state).toBe("queued");
    journal.claim(action.operationId);
    expect(journal.complete(result).state).toBe("completed");
    expect(journal.complete(structuredClone(result)).state).toBe("completed");
  });

  it("rejects conflicting operation IDs, sequences, and terminal results", () => {
    const journal = new ActionJournal();
    journal.register(action);
    expect(() => journal.register({ ...action, command: "whoami" })).toThrow(/different action input/);
    expect(() => journal.register({ ...action, operationId: "op-two" })).toThrow(/sequence is already owned/);
    journal.claim(action.operationId);
    journal.complete(result);
    expect(() => journal.complete({ ...result, stdout: "different" })).toThrow(/different result/);
  });

  it("enforces the action-specific combined UTF-8 output limit", () => {
    const journal = new ActionJournal();
    journal.register({ ...action, maxOutputBytes: 3 });
    journal.claim(action.operationId);
    expect(() => journal.complete({ ...result, stdout: "🌱", stderr: "" })).toThrow(/output byte limit/);
  });

  it("returns unresolved records in sequence order", () => {
    const journal = new ActionJournal();
    journal.register({ ...action, sequence: 2, operationId: "op-two" });
    journal.register(action);
    journal.claim(action.operationId);
    journal.markAmbiguous(action.operationId);

    expect(journal.unresolvedAfter(0).map((record) => [record.action.sequence, record.state])).toEqual([
      [1, "ambiguous"],
      [2, "queued"],
    ]);
    expect(journal.nextSequence()).toBe(3);
  });
});
