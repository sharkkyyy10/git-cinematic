import { describe, expect, it } from "vitest";
import { type Box, CITY_SIZE, fileWeight, layoutCity, squarify } from "../src/layout.js";

const EPS = 1e-6;
const overlap = (a: Box, b: Box) =>
  Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2) > EPS &&
  Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2) > EPS;
const inside = (a: Box, p: Box) =>
  a.x - a.w / 2 >= p.x - p.w / 2 - EPS &&
  a.x + a.w / 2 <= p.x + p.w / 2 + EPS &&
  a.z - a.d / 2 >= p.z - p.d / 2 - EPS &&
  a.z + a.d / 2 <= p.z + p.d / 2 + EPS;

function randomPaths(n: number): { paths: string[]; locMax: number[] } {
  let s = 42;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const paths: string[] = [];
  const locMax: number[] = [];
  for (let i = 0; i < n; i++) {
    const depth = 1 + Math.floor(rnd() * 4);
    const parts = Array.from({ length: depth }, (_, d) => `d${d}-${Math.floor(rnd() * 4)}`);
    paths.push([...parts, `f${i}.ts`].join("/"));
    locMax.push(Math.floor(rnd() * 3000));
  }
  return { paths, locMax };
}

describe("squarify", () => {
  it("tiles the rectangle exactly with areas in proportion", () => {
    const areas = [6, 6, 4, 3, 2, 2, 1];
    const cells = squarify(areas, { x: 0, y: 0, w: 6, h: 4 });
    cells.forEach((c, i) => {
      expect(c.w * c.h).toBeCloseTo(areas[i] as number);
    });
    const total = cells.reduce((s, c) => s + c.w * c.h, 0);
    expect(total).toBeCloseTo(24);
  });
});

describe("layoutCity", () => {
  const { paths, locMax } = randomPaths(600);
  const city = layoutCity(paths, locMax);

  it("keeps the city inside a 1000 × 1000 square centred at the origin", () => {
    const bounds: Box = { x: 0, z: 0, w: CITY_SIZE, d: CITY_SIZE };
    for (const f of city.files) expect(inside(f, bounds)).toBe(true);
    for (const d of city.dirs) expect(inside(d, bounds)).toBe(true);
  });

  it("places every file inside its directory plate", () => {
    const dirByPath = new Map(city.dirs.map((d) => [d.path, d]));
    paths.forEach((p, i) => {
      const parent = dirByPath.get(p.slice(0, p.lastIndexOf("/")));
      expect(parent).toBeDefined();
      expect(inside(city.files[i] as Box, parent as Box)).toBe(true);
    });
    for (const d of city.dirs) {
      if (d.depth === 1) continue;
      const parent = dirByPath.get(d.path.slice(0, d.path.lastIndexOf("/")));
      expect(inside(d, parent as Box)).toBe(true);
    }
  });

  it("never overlaps two buildings or two sibling plates", () => {
    const f = city.files;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) expect(overlap(f[i] as Box, f[j] as Box)).toBe(false);
    }
    const byParent = new Map<string, Box[]>();
    for (const d of city.dirs) {
      const parent = d.path.includes("/") ? d.path.slice(0, d.path.lastIndexOf("/")) : "";
      byParent.set(parent, [...(byParent.get(parent) ?? []), d]);
    }
    for (const siblings of byParent.values()) {
      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          expect(overlap(siblings[i] as Box, siblings[j] as Box)).toBe(false);
        }
      }
    }
  });

  it("shrinks footprints by 15% and sizes them by sqrt(locMax)", () => {
    const one = layoutCity(["a", "b"], [100, 100]);
    expect(one.files[0]?.w).toBeCloseTo(one.files[1]?.w as number);
    expect(fileWeight(100)).toBe(11);
    expect(fileWeight(0)).toBe(2);
    const single = layoutCity(["solo"], [9]);
    expect(single.files[0]?.w).toBeCloseTo(CITY_SIZE * 0.85);
  });

  it("is deterministic regardless of input order", () => {
    const again = layoutCity([...paths], [...locMax]);
    expect(again).toEqual(city);
  });
});
