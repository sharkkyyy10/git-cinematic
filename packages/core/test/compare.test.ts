import { describe, expect, it } from "vitest";
import { renderBadge } from "../src/badge.js";
import { compareCities, renderComparison } from "../src/compare.js";
import { buildDemoCity } from "../src/demo.js";
import { type City, hotspots, noiseKind } from "../src/format.js";
import { findings, health } from "../src/insights.js";

describe("noise", () => {
  it.each([
    ["package-lock.json", "lock file"],
    ["web/yarn.lock", "lock file"],
    ["Cargo.lock", "lock file"],
    ["go.sum", "lock file"],
    ["CHANGELOG.md", "changelog"],
    ["docs/HISTORY.rst", "changelog"],
    ["dist/app.js", "vendored"],
    ["vendor/lib/x.go", "vendored"],
    ["web/node_modules/a/index.js", "vendored"],
    ["src/__snapshots__/a.test.ts.snap", "vendored"],
    ["static/app.min.js", "generated"],
    ["api/user.pb.go", "generated"],
    ["lib/model.g.dart", "generated"],
  ])("%s is %s", (path, kind) => {
    expect(noiseKind(path)).toBe(kind);
  });

  it.each([
    "src/history.ts",
    "src/lock.ts",
    "packages/news-feed/index.ts",
    "build.mjs",
    "README.md",
    "src/changes/apply.ts",
  ])("%s is real code", (path) => {
    expect(noiseKind(path)).toBeNull();
  });

  it("never ranks noise as a hotspot, however big and busy", () => {
    const files = [
      { path: "package-lock.json", churn: 900, loc: 90_000, flags: 0 },
      { path: "CHANGELOG.md", churn: 800, loc: 5_000, flags: 0 },
      { path: "src/core.ts", churn: 50, loc: 1_200, flags: 0 },
      { path: "src/small.ts", churn: 2, loc: 30, flags: 0 },
    ];
    const ranked = hotspots(files);
    expect(ranked[0]?.index).toBe(2);
    expect(ranked.find((h) => h.index === 0)?.score).toBe(0);
    expect(ranked.find((h) => h.index === 1)?.score).toBe(0);
  });
});

function withFiles(city: City, edit: (c: City) => void): City {
  const copy: City = { ...city, files: city.files.map((f) => ({ ...f })), history: city.history.slice() };
  edit(copy);
  return copy;
}

describe("compareCities", () => {
  const demo = buildDemoCity();

  it("reports no change against itself", () => {
    const c = compareCities(demo, demo);
    expect(c.delta).toBe(0);
    expect(c.newHotspots).toEqual([]);
    expect(c.resolvedHotspots).toEqual([]);
    expect(c.newFires).toEqual([]);
    expect(c.grew).toEqual([]);
    expect(c.added).toBe(0);
    expect(c.removed).toBe(0);
  });

  it("sees health drop and new hotspots when a quiet file becomes big and busy", () => {
    const quiet = demo.files.findIndex((f) => f.churn === 1 && f.loc > 0 && f.loc < 100 && !f.path.endsWith("(other)"));
    expect(quiet).toBeGreaterThanOrEqual(0);
    const worse = withFiles(demo, (c) => {
      const f = c.files[quiet];
      if (!f) return;
      f.loc = 9_000;
      f.churn = 400;
      f.fixes = 300;
    });
    const c = compareCities(demo, worse);
    const path = demo.files[quiet]?.path ?? "";
    expect(c.newHotspots).toContain(path);
    expect(c.delta).toBeLessThan(0);
    expect(c.grew[0]?.path).toBe(path);
    const md = renderComparison(c);
    expect(md).toContain("## Since the baseline");
    expect(md).toContain("▼");
    expect(md).toContain(path);
  });

  it("lists hotspots that went away as resolved", () => {
    const top = findings(demo).find((f) => f.id === "hotspots")?.matches[0] ?? -1;
    const better = withFiles(demo, (c) => {
      const f = c.files[top];
      if (f) f.flags |= 1; // deleted
    });
    expect(compareCities(demo, better).resolvedHotspots).toContain(demo.files[top]?.path);
  });
});

describe("badge", () => {
  it("is a valid, self-contained SVG with the score and grade", () => {
    const svg = renderBadge(health(buildDemoCity()).score);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="\d+" height="20"/);
    expect(svg).toMatch(/aria-label="code health: \d+\/100 \(grade [A-E]\)"/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
  });

  it("colours by grade and escapes the label", () => {
    expect(renderBadge(95)).toContain("#2ea44f");
    expect(renderBadge(10)).toContain("#e05d44");
    expect(renderBadge(50, "a<b & c")).toContain("a&lt;b &amp; c");
  });
});
