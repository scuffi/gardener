import { describe, expect, it } from "vitest";
import { HARNESS_ADAPTER_VERSIONS } from "../src/harness";
import { isCurrentFlueRun } from "../src/run-admission";

describe("Flue run admission", () => {
  it("reconciles only runs pinned to the current Flue adapter", () => {
    expect(isCurrentFlueRun({ harnessId: "flue", harnessVersion: HARNESS_ADAPTER_VERSIONS.flue })).toBe(true);
    expect(isCurrentFlueRun({ harnessId: "cloudflare-agents", harnessVersion: "1.0.0" })).toBe(false);
    expect(isCurrentFlueRun({ harnessId: "think", harnessVersion: "1.0.0" })).toBe(false);
    expect(isCurrentFlueRun({ harnessId: "flue", harnessVersion: "1.0.0" })).toBe(false);
  });
});
