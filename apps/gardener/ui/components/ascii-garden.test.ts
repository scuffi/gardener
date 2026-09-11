import { describe, expect, it } from "vitest";
import { renderAsciiGarden, renderAsciiGardenScene } from "./ascii-garden";

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
    expect(first.replace(/[ |/\\'_,.():*+o@`\n-]/g, "")).toBe("");
  });

  it("mixes obvious flowers, seed heads, weeds, and low plants into the near field", () => {
    const scene = renderAsciiGardenScene({ ...options, columns: 220, seed: 53 });
    const activeBloomLayers = scene.blooms.filter((layer) => layer.replace(/[ \n]/g, "").length > 0);

    expect(scene.field).toMatch(/[+*o@]/);
    expect(scene.field).toContain(":");
    expect(scene.field).toContain("o");
    expect(activeBloomLayers).toHaveLength(4);
    expect(scene.blooms.join("").replace(/[ \n]/g, "").length).toBeGreaterThan(20);
    for (const layer of scene.blooms) {
      expect(layer.split("\n")).toHaveLength(16);
      expect(layer.split("\n").every((line) => line.length === 220)).toBe(true);
      for (let index = 0; index < layer.length; index += 1) {
        if (layer[index] !== " " && layer[index] !== "\n") expect(scene.field[index]).toBe(layer[index]);
      }
    }
  });

  it("uses the seed to vary species, shapes, and bloom palettes", () => {
    const first = renderAsciiGardenScene({ ...options, columns: 220, seed: 1 });
    const second = renderAsciiGardenScene({ ...options, columns: 220, seed: 2 });

    expect(second.field).not.toBe(first.field);
    expect(second.blooms).not.toEqual(first.blooms);
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

  it("maps interaction near the right edge to right-edge grass", () => {
    const wide = { ...options, columns: 220 };
    const calm = renderAsciiGarden(wide).split("\n");
    const moved = renderAsciiGarden({ ...wide, pointer: { column: 210, row: 12, strength: 1 } }).split("\n");
    const changedColumns: number[] = [];
    for (let row = 0; row < calm.length; row += 1) for (let column = 0; column < calm[row]!.length; column += 1) {
      if (calm[row]![column] !== moved[row]![column]) changedColumns.push(column);
    }

    expect(changedColumns.length).toBeGreaterThan(0);
    expect(Math.min(...changedColumns)).toBeGreaterThanOrEqual(185);
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
