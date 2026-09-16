import { describe, expect, it, vi } from "vitest";
import { HARNESS_ADAPTER_VERSIONS } from "../src/harness";

vi.mock("../src/flue-native-runtime", () => ({ ensureInitialFlueDispatch: vi.fn() }));

import { isCurrentFlueRun } from "../src/run-admission";

describe("Flue-native run admission", () => {
  it("reconciles only runs pinned to the immutable native driver and current adapter", () => {
    expect(isCurrentFlueRun({
      runtimeDriver: "flue-native-v1",
      nativeProfile: "bounded-issue-comment-v4",
      nativeRequestProtocol: "gardener-flue-request/v1",
      harnessId: "flue",
      harnessVersion: HARNESS_ADAPTER_VERSIONS.flue,
    })).toBe(true);
    expect(isCurrentFlueRun({ harnessId: "flue", harnessVersion: HARNESS_ADAPTER_VERSIONS.flue })).toBe(false);
    expect(isCurrentFlueRun({ runtimeDriver: "workflow-v1", harnessId: "flue", harnessVersion: HARNESS_ADAPTER_VERSIONS.flue })).toBe(false);
    expect(isCurrentFlueRun({ runtimeDriver: "flue-native-v1", nativeProfile: "bounded-issue-comment-v4", nativeRequestProtocol: "gardener-flue-request/v1", harnessId: "flue", harnessVersion: "2.0.2" })).toBe(false);
  });
});
