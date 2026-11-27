import { describe, expect, it } from "vitest";
import { type MapFrame, mapToWorld, worldToMap } from "../src/hud.js";
import { laneLoops, plateTop, streetMargin } from "../src/streets.js";
import { outskirtBlocks } from "../src/world.js";

describe("minimap transform", () => {
  const frames: MapFrame[] = [
    { cx: 88, cy: 88, scale: 0.2, tx: 0, tz: 0, fx: 0, fz: -1 },
    { cx: 88, cy: 88, scale: 0.35, tx: 120, tz: -40, fx: Math.SQRT1_2, fz: Math.SQRT1_2 },
  ];

  it("puts the camera target in the centre and the view direction straight up", () => {
    for (const m of frames) {
      expect(worldToMap(m, m.tx, m.tz)).toEqual([88, 88]);
      const [x, y] = worldToMap(m, m.tx + m.fx * 100, m.tz + m.fz * 100);
      expect(x).toBeCloseTo(88);
      expect(y).toBeLessThan(88);
    }
  });

  it("is a north-up map when looking north", () => {
    const m = frames[0] as MapFrame;
    const [x, y] = worldToMap(m, 100, 0); // east
    expect(x).toBeGreaterThan(88);
    expect(y).toBeCloseTo(88);
  });

  it("inverts exactly", () => {
    for (const m of frames) {
      const [px, py] = worldToMap(m, 333, -71);
      const [x, z] = mapToWorld(m, px, py);
      expect(x).toBeCloseTo(333);
      expect(z).toBeCloseTo(-71);
    }
  });
});

describe("streets", () => {
  const dir = (depth: number, w: number, d: number) => ({ path: `p${depth}`, depth, x: 10, z: -20, w, d });

  it("mirrors the layout's street widths and clamps them on small blocks", () => {
    expect(streetMargin(dir(1, 200, 200))).toBe(4);
    expect(streetMargin(dir(2, 200, 200))).toBe(2);
    expect(streetMargin(dir(1, 8, 200))).toBe(2);
  });

  it("runs one lane loop inside the street ring of districts and neighbourhoods only", () => {
    const lanes = laneLoops([dir(1, 200, 100), dir(2, 60, 40), dir(3, 60, 40), dir(1, 4, 4)]);
    expect(lanes).toHaveLength(2);
    const [a] = lanes;
    if (!a) return;
    expect(a.x).toBeGreaterThan(10 - 100);
    expect(a.x + a.w).toBeLessThan(10 + 100);
    expect(a.z).toBeGreaterThan(-20 - 50);
    expect(a.z + a.d).toBeLessThan(-20 + 50);
    expect(a.y).toBeCloseTo(plateTop(1) + 0.02);
  });
});

describe("outskirts", () => {
  it("is deterministic and never builds over the city", () => {
    const a = outskirtBlocks();
    expect(a).toEqual(outskirtBlocks());
    expect(a.length).toBeGreaterThan(1000);
    expect(a.length).toBeLessThan(15000);
    for (const b of a) {
      const inside = Math.abs(b.x) - b.w / 2 < 520 && Math.abs(b.z) - b.d / 2 < 520;
      expect(inside).toBe(false);
      expect(b.h).toBeGreaterThan(0);
    }
  });
});
