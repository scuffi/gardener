import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256, deepFreeze } from "../src";

describe("canonical JSON", () => {
  it("sorts keys recursively and omits undefined properties", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"e":2,"f":1}]},"b":1}');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("hashes canonically equivalent values identically", async () => {
    const left = await canonicalSha256({ a: 1, b: [true, "x"] });
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(await canonicalSha256({ b: [true, "x"], a: 1 })).toBe(left);
    expect(await canonicalSha256({ a: 2, b: [true, "x"] })).not.toBe(left);
  });

  it("freezes nested values", () => {
    const value = deepFreeze({ a: { b: [1] } });
    expect(Object.isFrozen(value.a.b)).toBe(true);
  });
});
