import { describe, expect, it } from "vitest";
import { buildDemoCity } from "../src/demo.js";
import { type City, type CityFile, FILE_DELETED } from "../src/format.js";
import { fileSignals, findings, gradeFor, health, isAlive, LENS_IDS, LENSES, renderReport } from "../src/insights.js";

type Spec = Partial<CityFile> & { path: string; locs: number[]; heats?: number[] };

/** A tiny city with hand-written history: locs and heats per bucket (heat in 0..1). */
function makeCity(specs: Spec[], authors = ["ada", "bo"]): City {
  const B = specs[0]?.locs.length ?? 1;
  const history = new Uint16Array(specs.length * B * 2);
  specs.forEach((s, i) => {
    for (let b = 0; b < B; b++) {
      history[(i * B + b) * 2] = s.locs[b] ?? 0;
      history[(i * B + b) * 2 + 1] = Math.round((s.heats?.[b] ?? 0) * 65535);
    }
  });
  return {
    flags: 0,
    generatedAt: 1_700_000_000 + B * 86_400,
    repoName: "fixture",
    bucketStart: Uint32Array.from({ length: B }, (_, b) => 1_700_000_000 + b * 86_400),
    files: specs.map((s) => ({
      x: 0,
      z: 0,
      w: 1,
      d: 1,
      loc: s.locs[B - 1] ?? 0,
      locMax: Math.max(...s.locs),
      churn: 0,
      fixes: 0,
      centrality: 0,
      authors: 1,
      flags: 0,
      ...s,
    })),
    dirs: [],
    authors,
    eras: [{ title: "Steady build · src", startBucket: 0, endBucket: B - 1, kind: 0 }],
    history,
  };
}

const fixture = () =>
  makeCity([
    // A big, busy, fix-heavy file owned by one person, still on fire.
    {
      path: "src/billing.ts",
      locs: [100, 900, 1800, 2500],
      heats: [0, 0.3, 0.6, 0.9],
      churn: 40,
      fixes: 12,
      centrality: 0.9,
    },
    // Shared, steady, untouched since the start.
    { path: "src/legacy.ts", locs: [2000, 2000, 2000, 2000], churn: 4, authors: 3, centrality: 0.2 },
    // Small and quiet.
    { path: "src/util.ts", locs: [0, 10, 12, 12], churn: 3, fixes: 1, authors: 2, centrality: 0.1 },
    // Gone.
    { path: "src/old.ts", locs: [50, 50, 0, 0], churn: 2, flags: FILE_DELETED, centrality: 0 },
  ]);

describe("fileSignals", () => {
  it("gives every lens a 0..1 value and zero for deleted files", () => {
    const s = fileSignals(fixture());
    for (const id of LENS_IDS) {
      expect(s[id]).toHaveLength(4);
      for (const v of s[id]) expect(v).toBeGreaterThanOrEqual(0);
      for (const v of s[id]) expect(v).toBeLessThanOrEqual(1);
      expect(s[id][3]).toBe(0);
    }
  });

  it("ranks the big, busy, fix-heavy, single-owner file highest on risk, bugs and silos", () => {
    const s = fileSignals(fixture());
    for (const id of ["risk", "bugs", "silos", "coupling"] as const) {
      const best = [...s[id]].indexOf(Math.max(...s[id]));
      expect(best, id).toBe(0);
    }
  });

  it("tracks the last visible change and the heat at the end", () => {
    const s = fileSignals(fixture());
    expect([...s.lastChange]).toEqual([3, 0, 2, 2]);
    expect(s.age[1]).toBe(1); // untouched since the first bucket
    expect(s.age[0]).toBe(0);
    expect(s.heatNow[0]).toBeCloseTo(0.9, 3);
  });

  it("has no silos in a single-author repository", () => {
    const c = fixture();
    c.authors = ["ada"];
    expect(Math.max(...fileSignals(c).silos)).toBe(0);
  });
});

describe("health", () => {
  it("scores 0..100 with a grade and explains every part", () => {
    const h = health(fixture());
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
    expect(h.grade).toBe(gradeFor(h.score));
    expect(h.parts.map((p) => p.id)).toEqual(["fixLoad", "knowledge", "fireNow", "fileSize"]);
    for (const p of h.parts) expect(p.detail.length).toBeGreaterThan(10);
  });

  it("drops the knowledge part for a single author and still weighs to 100", () => {
    const c = makeCity([{ path: "a.ts", locs: [10, 20], churn: 2 }], ["solo"]);
    const h = health(c);
    expect(h.parts.some((p) => p.id === "knowledge")).toBe(false);
    expect(h.score).toBe(100);
    expect(h.grade).toBe("A");
  });

  it("is worse when more changes are fixes", () => {
    const calm = makeCity([{ path: "a.ts", locs: [10, 20], churn: 10, fixes: 0 }]);
    const buggy = makeCity([{ path: "a.ts", locs: [10, 20], churn: 10, fixes: 6 }]);
    expect(health(buggy).score).toBeLessThan(health(calm).score);
  });

  it("maps grades at the boundaries", () => {
    expect([85, 84, 70, 55, 40, 39].map(gradeFor)).toEqual(["A", "B", "B", "C", "D", "E"]);
  });
});

describe("findings", () => {
  it("names the burning file in hotspots, fire, bugs and silos, most severe first", () => {
    const found = findings(fixture());
    const ids = found.map((f) => f.id);
    for (const id of ["hotspots", "fire", "bugs", "silos", "coupling", "dormant"] as const) {
      expect(ids, id).toContain(id);
    }
    const sev = found.map((f) => f.severity);
    expect(sev).toEqual(
      [...sev].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)),
    );
    for (const id of ["fire", "bugs", "silos"]) expect(found.find((f) => f.id === id)?.files[0]).toBe(0);
    expect(found.find((f) => f.id === "dormant")?.files).toEqual([1]);
    for (const f of found) for (const i of f.files) expect(isAlive(fixture().files[i] as CityFile)).toBe(true);
  });

  it("says a single-author repository is a silo by definition instead of listing files", () => {
    const c = makeCity([{ path: "main.html", locs: [1082], churn: 1 }], ["solo"]);
    const found = findings(c);
    expect(found.map((f) => f.id)).toEqual(["solo"]);
  });

  it("every lens a finding points to exists", () => {
    const ids = new Set(LENSES.map((l) => l.id));
    for (const f of findings(buildDemoCity())) if (f.lens) expect(ids.has(f.lens)).toBe(true);
  });
});

describe("report", () => {
  it("renders the score, the story, the findings and the method", () => {
    const text = renderReport(fixture());
    expect(text).toMatch(/^# fixture: codebase report/);
    expect(text).toMatch(/## Health: \d+\/100 \(grade [A-E]\)/);
    expect(text).toContain("## The story so far");
    expect(text).toContain("`src/billing.ts`");
    expect(text).toContain("## How to read this");
  });

  it("is deterministic and escapes Markdown in names", () => {
    const c = fixture();
    c.repoName = "a|b*c";
    expect(renderReport(c)).toBe(renderReport(c));
    expect(renderReport(c)).toContain("# a\\|b\\*c: codebase report");
  });

  it("finds real problems in the demo city", () => {
    const demo = buildDemoCity();
    const h = health(demo);
    expect(h.score).toBeGreaterThan(20);
    expect(h.score).toBeLessThan(95);
    expect(findings(demo).length).toBeGreaterThanOrEqual(4);
  });
});
