import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDemoCity, mulberry32, simulateDemo } from "../src/demo.js";
import { EraKind, FILE_DELETED } from "../src/format.js";
import { packCity } from "../src/gzip.js";

describe("demo city", () => {
  const city = buildDemoCity();

  it("is seeded and deterministic", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(packCity(buildDemoCity()).equals(packCity(city))).toBe(true);
  });

  it("matches the committed landing-page city (run `npm run demo` after changing the generator)", () => {
    const committed = readFileSync(new URL("../../viewer/public/demo/city.bin", import.meta.url));
    expect(committed.equals(packCity(city))).toBe(true);
  });

  it("simulates a six-year monorepo with 12 authors and about 2,400 files", () => {
    expect(city.authors).toHaveLength(12);
    expect(city.files.length).toBeGreaterThan(2100);
    expect(city.files.length).toBeLessThan(2700);
    const first = city.bucketStart[0] as number;
    const years = (city.generatedAt - first) / (365 * 86400);
    expect(years).toBeGreaterThan(5.8);
    expect(years).toBeLessThan(6.1);
  });

  it("tells the story: expansion, fix waves, a large cleanup and one big rename", () => {
    const kinds = new Set(city.eras.map((e) => e.kind));
    expect(kinds).toContain(EraKind.Expansion);
    expect(kinds).toContain(EraKind.FixWave);
    expect(kinds).toContain(EraKind.Cleanup);
    expect(city.eras.filter((e) => e.kind === EraKind.FixWave).length).toBeGreaterThanOrEqual(3);
    expect(city.files.filter((f) => f.flags & FILE_DELETED).length).toBeGreaterThan(200);
    expect(city.files.some((f) => f.path.startsWith("packages/design-system/"))).toBe(true);
    expect(city.files.some((f) => f.path.startsWith("packages/ui-kit/"))).toBe(false);
    const rename = simulateDemo().commits.find((c) => c.subject.includes("rename ui-kit"));
    expect(rename?.changes.length).toBeGreaterThan(50);
  });
});
