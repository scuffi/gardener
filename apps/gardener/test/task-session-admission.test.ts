import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `session.ts` imports `cloudflare:workers` and cannot be loaded under vitest,
 * so the decisions it makes at admission live in pure modules tested on their
 * own (session-checks, run-admissions). These pin how `runTask` wires them in,
 * from its source.
 */
const source = readFileSync(new URL("../src/task-runtime/session.ts", import.meta.url), "utf8");
const runTask = source.slice(source.indexOf("  async runTask("), source.indexOf("  async #settleAndPersist("));

describe("runTask admission wiring", () => {
  it("decides the starter for a fresh request only; a persisted request keeps what it has", () => {
    expect(runTask).toContain(`    const request = existing
      ? taskRunRequestV1Schema.parse(JSON.parse(existing.request_json))
      : withStarter(taskRunRequestV1Schema.parse(freshRequest), identity, runnerEvent);`);
    expect(source).toMatch(/trustedStarter\(\{\n\s+eventName: identity\.hello\.eventName,\n\s+actor: \{ id: identity\.actor\.actorId, login: identity\.actor\.actorLogin \},\n\s+event: request\.event,\n\s+actorPermission: event\.actorPermission,\n\s+\}\)/);
  });

  it("checks run limits after the outcome, cancel and trigger-filter checks and before the harness request", () => {
    const order = [
      "if (existing?.outcome_json)",
      "const cancelReason = await this.ctx.storage.get<string>(\"cancel-intent\")",
      "if (triggerFiltersExclude(request.event, request.bundle.triggers))",
      "const admission = await admitRun(this.#db(), {",
      "const harnessRequest = await createTaskHarnessRequest(request);",
    ].map((needle) => runTask.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("counts the OIDC actor, exempts trusted starters from the per-author limit, and never stops a started run", () => {
    expect(runTask).toContain("if (!existing?.harness_submission_json) {");
    expect(runTask).toContain("authorId: request.event.actor.id,");
    expect(runTask).toContain("trusted: request.starter?.trusted === true,");
    expect(runTask).toContain("limits: request.bundle.limits,");
  });

  it("settles an over-limit run as a completed skip without the model, like a filtered run", () => {
    const skip = runTask.slice(runTask.indexOf("if (!admission.admitted)"), runTask.indexOf("const harnessRequest"));
    expect(skip).toContain("return this.#settleAndPersist(request, taskOutcomeV1Schema.parse({");
    expect(skip).toContain(`status: "completed",`);
    expect(skip).toContain("summary: admission.summary,");
    expect(skip).toContain("proposedEffects: [],");
    expect(skip).toContain(`}), bundleHash, { skipped: "rate_limit" });`);
  });
});
