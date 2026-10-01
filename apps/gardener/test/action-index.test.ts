import { describe, expect, it } from "vitest";
import { ACTION_PREFIX, actionEntries, indexIfFirstAction, listActionSummaries } from "../src/task-runtime/action-index";
import { MemoryStorage } from "./memory-storage";

function record(index: number, state: "running" | "ambiguous" | "completed" = "completed") {
  const operationId = `op_${String(index).padStart(4, "0")}`;
  return {
    canonicalAction: "{}",
    state,
    action: { operationId, sequence: index + 1 },
    // Stands in for a large shell result that the summaries must never load.
    result: { stdout: "x".repeat(1_000) },
  };
}

describe("runner action index", () => {
  it("reads summaries, not full records, once a session keeps the index", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 600; index += 1) {
      await indexIfFirstAction(storage);
      await storage.put(actionEntries(record(index, index === 599 ? "ambiguous" : "completed")));
    }
    const summaries = await listActionSummaries(storage);
    expect(summaries).toHaveLength(600);
    expect(summaries.at(-1)).toEqual({ operationId: "op_0599", sequence: 600, state: "ambiguous" });
    // Paged through the small summaries; the full records were never listed.
    expect(storage.lists.filter((list) => list.prefix === ACTION_PREFIX && list.limit !== 1)).toEqual([]);
    expect(storage.lists.filter((list) => list.prefix === "action-meta:").length).toBe(2);
  });

  it("keeps the summary in step with each state change", async () => {
    const storage = new MemoryStorage();
    await indexIfFirstAction(storage);
    await storage.put(actionEntries(record(0, "running")));
    await storage.put(actionEntries(record(0, "completed")));
    expect(await listActionSummaries(storage)).toEqual([{ operationId: "op_0000", sequence: 1, state: "completed" }]);
  });

  it("pages through full records for a session written before the index", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 20; index += 1) {
      await storage.put(`${ACTION_PREFIX}${record(index).action.operationId}`, record(index, index < 3 ? "running" : "completed"));
    }
    // Its next action must not switch it to the index: the earlier actions have no summaries.
    await indexIfFirstAction(storage);
    await storage.put(actionEntries(record(20)));
    const summaries = await listActionSummaries(storage);
    expect(summaries).toHaveLength(21);
    expect(summaries.filter((summary) => summary.state === "running").map((summary) => summary.operationId))
      .toEqual(["op_0000", "op_0001", "op_0002"]);
    const pages = storage.lists.filter((list) => list.prefix === ACTION_PREFIX && list.limit !== 1);
    expect(pages.every((list) => list.limit === 2)).toBe(true);
    expect(pages).toHaveLength(11);
  });

  it("keeps scanning full records when only later actions have summaries", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${ACTION_PREFIX}op_0000`, record(0, "running"));
    // Written by the new code after a deploy: summaries exist, but the index flag must not.
    for (let index = 1; index < 4; index += 1) {
      await indexIfFirstAction(storage);
      await storage.put(actionEntries(record(index)));
    }
    const summaries = await listActionSummaries(storage);
    expect(summaries.map((summary) => summary.operationId)).toEqual(["op_0000", "op_0001", "op_0002", "op_0003"]);
    expect(summaries[0]!.state).toBe("running");
    expect(storage.lists.some((list) => list.prefix === "action-meta:")).toBe(false);
  });
});
