import { describe, expect, it } from "vitest";
import { renderAsciiGarden } from "./ascii-garden";

const options = { columns: 80, rows: 16, timeMs: 1_000, seed: 17, depth: 1 } as const;

describe("ASCII garden", () => {
  it("is deterministic, bounded, and contains only the intended ASCII vocabulary", () => {
    const first = renderAsciiGarden(options);
    const second = renderAsciiGarden(options);
    const lines = first.split("\n");

    expect(second).toBe(first);
    expect(lines).toHaveLength(16);
    expect(lines.every((line) => line.length === 80)).toBe(true);
    expect(first).toMatch(/[|/\\]/);
    expect(first.replace(/[ |/\\'_,.\n]/g, "")).toBe("");
  });

  it("animates with ambient time while preserving its dimensions", () => {
    const first = renderAsciiGarden({ ...options, timeMs: 0 });
    const later = renderAsciiGarden({ ...options, timeMs: 2_400 });

    expect(later).not.toBe(first);
    expect(later.length).toBe(first.length);
  });

  it("keeps pointer disturbance local to the nearby grass", () => {
    const calm = renderAsciiGarden(options).split("\n");
    const moved = renderAsciiGarden({ ...options, pointer: { column: 40, row: 10, strength: 1 } }).split("\n");
    const changedColumns = new Set<number>();

    for (let row = 0; row < calm.length; row += 1) {
      for (let column = 0; column < calm[row]!.length; column += 1) {
        if (calm[row]![column] !== moved[row]![column]) changedColumns.add(column);
      }
    }

    expect(changedColumns.size).toBeGreaterThan(0);
    expect(Math.min(...changedColumns)).toBeGreaterThanOrEqual(14);
    expect(Math.max(...changedColumns)).toBeLessThanOrEqual(66);
  });

  it("clamps tiny and oversized fields to safe rendering limits", () => {
    const tiny = renderAsciiGarden({ ...options, columns: 1, rows: 1 }).split("\n");
    const large = renderAsciiGarden({ ...options, columns: 2_000, rows: 2_000 }).split("\n");

    expect(tiny).toHaveLength(8);
    expect(tiny[0]).toHaveLength(24);
    expect(large).toHaveLength(24);
    expect(large[0]).toHaveLength(220);
  });
});
