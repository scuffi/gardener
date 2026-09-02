import { describe, expect, it } from "vitest";
import { setupPolicyProfile } from "../src/setup";

describe("guided setup profiles", () => {
  it("uses the safe preset without automatic comments or state changes", () => {
    const profile = setupPolicyProfile("safe");
    expect(profile["issue.label.add"]).toBe("automatic");
    expect(profile["issue.comment.create"]).toBe("approval");
    expect(profile["issue.close"]).toBe("disabled");
    expect(profile["issue.reopen"]).toBe("disabled");
  });

  it("returns a copy so callers cannot mutate a preset", () => {
    const one = setupPolicyProfile("labels");
    one["issue.comment.create"] = "automatic";
    expect(setupPolicyProfile("labels")["issue.comment.create"]).toBe("disabled");
  });
});
