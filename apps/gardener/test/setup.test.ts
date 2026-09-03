import { operationKindSchema, type OperationKind } from "@gardener/contracts";
import { describe, expect, it } from "vitest";
import { setupPolicyProfile } from "../src/setup";

const maintainerOperations = [
  "branch.create",
  "commit.create",
  "pull_request.open",
  "pull_request.update",
  "pull_request.review.submit",
  "pull_request.merge",
] as const satisfies readonly OperationKind[];

describe("guided setup profiles", () => {
  it("uses the safe preset without automatic comments, state changes, code changes, or pull requests", () => {
    const profile = setupPolicyProfile("safe");
    expect(Object.keys(profile).sort()).toEqual([...operationKindSchema.options].sort());
    expect(profile["issue.label.add"]).toBe("automatic");
    expect(profile["issue.label.remove"]).toBe("approval");
    expect(profile["issue.comment.create"]).toBe("approval");
    expect(profile["issue.close"]).toBe("disabled");
    expect(profile["issue.reopen"]).toBe("disabled");
    for (const operation of maintainerOperations) expect(profile[operation]).toBe("disabled");
  });

  it("keeps maintainer operations disabled in every issue preset", () => {
    for (const id of ["safe", "review", "labels"] as const) {
      const profile = setupPolicyProfile(id);
      expect(Object.keys(profile).sort()).toEqual([...operationKindSchema.options].sort());
      for (const operation of maintainerOperations) expect(profile[operation]).toBe("disabled");
    }
  });

  it("returns a copy so callers cannot mutate a preset", () => {
    const one = setupPolicyProfile("labels");
    one["issue.comment.create"] = "automatic";
    expect(setupPolicyProfile("labels")["issue.comment.create"]).toBe("disabled");
  });
});
