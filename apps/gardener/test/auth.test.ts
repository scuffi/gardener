import { describe, expect, it } from "vitest";
import { instanceId } from "../src/env";

describe("customer-owned workspace identity", () => {
  it("uses a stable non-secret workspace id", () => {
    expect(instanceId({ GARDENER_WORKSPACE_ID: "workspace-1" })).toBe("workspace-1");
    expect(() => instanceId({ GARDENER_WORKSPACE_ID: "" })).toThrow(
      "Invalid Gardener workspace id",
    );
    expect(() => instanceId({ GARDENER_WORKSPACE_ID: "contains spaces" })).toThrow(
      "Invalid Gardener workspace id",
    );
  });
});
