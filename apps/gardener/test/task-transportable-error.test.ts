import { describe, expect, it } from "vitest";
import { taskEffectProposalV1Schema } from "@gardener/contracts";
import { transportableError } from "../src/task-runtime/transportable-error";

describe("errors crossing the Durable Object RPC boundary", () => {
  it("keeps a validation error's pointers and messages through a structured clone", () => {
    const parsed = taskEffectProposalV1Schema.safeParse({
      stepName: "release",
      kind: "release.create",
      payload: { tagName: "v1", unexpected: true },
      rationale: "Draft the release.",
    });
    if (parsed.success) throw new Error("fixture unexpectedly parsed");
    // The failure this guards: a Zod 4 error loses its message when cloned.
    expect(structuredClone(parsed.error).message).not.toContain("/payload");

    const cloned = structuredClone(transportableError(parsed.error));
    expect(cloned.message).toMatch(/^\/payload: /);
    expect(cloned.message).toContain("targetCommitSha");
  });

  it("passes any other error through unchanged, keeping its type and name", () => {
    const plain = new Error("Task did not declare the release.create effect");
    expect(transportableError(plain)).toBe(plain);
    const aborted = new DOMException("The operation was aborted", "AbortError");
    expect(transportableError(aborted)).toBe(aborted);
    expect(structuredClone(transportableError(aborted)).name).toBe("AbortError");
  });
});
