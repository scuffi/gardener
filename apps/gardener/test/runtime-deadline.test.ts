import { describe, expect, it } from "vitest";
import { boundedModelRuntimeMs, MAX_FLUE_RUNTIME_MS } from "../src/runtime-deadline";

describe("Flue-native deadline ownership", () => {
  it("caps every frozen submission at the explicit Agent durability ceiling", () => {
    expect(MAX_FLUE_RUNTIME_MS).toBe(900_000);
    expect(boundedModelRuntimeMs(60)).toBe(60_000);
    expect(boundedModelRuntimeMs(900)).toBe(MAX_FLUE_RUNTIME_MS);
    expect(boundedModelRuntimeMs(3_600)).toBe(MAX_FLUE_RUNTIME_MS);
  });
});
