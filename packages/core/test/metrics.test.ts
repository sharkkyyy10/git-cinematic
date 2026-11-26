import { afterEach, describe, expect, it } from "vitest";
import type { CommitEvent, IngestResult } from "../src/ingest.js";
import { ingest } from "../src/ingest.js";
import {
  buildModel,
  coChangeGraph,
  isFixCommit,
  isMassCommit,
  MASS_COMMIT_FILES,
  makeBuckets,
  normalise,
  pageRank,
} from "../src/metrics.js";
import { createFixture, type Fixture, lines } from "./helpers.js";

let fx: Fixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

const commit = (fileIds: number[], subject = "change", time = 0): CommitEvent => ({
  sha: `${time}-${fileIds.join(",")}`,
  time,
  authorIndex: 0,
  subject,
  changes: fileIds.map((fileId) => ({ fileId, added: 1, deleted: 0 })),
});

describe("fix detection", () => {
  it.each([
    "fix: handle empty input",
    "Fix(parser): off by one",
    "hotfix!: revert config",
    "bugfix: null check",
    "BUGFIX(core)!: crash on start",
    "Fixes #12",
    "Handle the crash when closing",
    "Resolve regression in layout",
    "squash bugs in timeline",
    "fixed typo",
  ])("detects %j", (s) => {
    expect(isFixCommit(s)).toBe(true);
  });

  it.each([
    "feat: add prefix option",
    "refactor: suffixes and prefixes",
    "debug logging for renderer",
    "chore: bump fixtures",
    "docs: explain the crashpad integration",
    "feat: ladybugs easter egg",
    "fixups for docs",
  ])("ignores %j", (s) => {
    expect(isFixCommit(s)).toBe(false);
  });
});

describe("mass commits", () => {
  it("are those touching more than 50 files", () => {
    expect(MASS_COMMIT_FILES).toBe(50);
    expect(isMassCommit(commit(Array.from({ length: 50 }, (_, i) => i)))).toBe(false);
    expect(isMassCommit(commit(Array.from({ length: 51 }, (_, i) => i)))).toBe(true);
  });

  it("are excluded from churn, fixes and coupling but still count lines", async () => {
    fx = createFixture();
    for (let i = 0; i < 60; i++) fx.write(`gen/f${String(i).padStart(2, "0")}.ts`, lines(3));
    fx.commit("feat: add generated files", 0);
    for (let i = 0; i < 60; i++) fx.write(`gen/f${String(i).padStart(2, "0")}.ts`, lines(5));
    fx.commit("fix: reformat everything", 1);
    fx.write("gen/f00.ts", lines(6));
    fx.write("gen/f01.ts", lines(6));
    fx.commit("fix: small bug", 2);

    const model = buildModel(await ingest(fx.dir));
    const f00 = model.paths.indexOf("gen/f00.ts");
    const f02 = model.paths.indexOf("gen/f02.ts");
    expect(model.files[f00]).toMatchObject({ churn: 1, fixes: 1, loc: 6, locMax: 6 });
    expect(model.files[f02]).toMatchObject({ churn: 0, fixes: 0, loc: 5, locMax: 5 });
    // Only f00 and f01 are coupled, so they share the top centrality.
    const f01 = model.paths.indexOf("gen/f01.ts");
    expect(model.files[f00]?.centrality).toBeCloseTo(1);
    expect(model.files[f01]?.centrality).toBeCloseTo(1);
    expect(model.files[f02]?.centrality).toBe(0);
  });
});

describe("co-change PageRank", () => {
  it("weights pairs by 1/(n-1) and skips single-file and mass commits", () => {
    const adj = coChangeGraph(4, [
      commit([0, 1]),
      commit([0, 1, 2]),
      commit([3]),
      commit(Array.from({ length: 51 }, (_, i) => i % 4)),
    ]);
    expect(adj[0]?.get(1)).toBeCloseTo(1.5);
    expect(adj[1]?.get(2)).toBeCloseTo(0.5);
    expect(adj[3]?.size).toBe(0);
  });

  it("ranks a hub above its spokes and spokes above isolated files", () => {
    // 0 is the hub, 1-4 spokes, 5 isolated.
    const commits = [commit([0, 1]), commit([0, 2]), commit([0, 3]), commit([0, 4]), commit([1, 2]), commit([5])];
    const rank = pageRank(coChangeGraph(6, commits));
    const order = [...rank.keys()].sort((a, b) => (rank[b] as number) - (rank[a] as number));
    expect(order[0]).toBe(0);
    expect(order[order.length - 1]).toBe(5);
    expect(rank[1]).toBeGreaterThan(rank[3] as number);
    const sum = rank.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    const norm = normalise(rank);
    expect(norm[0]).toBe(1);
    expect(norm[5]).toBe(0);
  });

  it("orders real co-change history the same way", async () => {
    fx = createFixture();
    fx.write("core.ts", lines(5));
    fx.write("a.ts", lines(5));
    fx.write("b.ts", lines(5));
    fx.write("c.ts", lines(5));
    fx.write("lonely.ts", lines(5));
    fx.commit("feat: start", 0);
    const edits: [string, string][] = [
      ["core.ts", "a.ts"],
      ["core.ts", "b.ts"],
      ["core.ts", "c.ts"],
      ["core.ts", "a.ts"],
    ];
    edits.forEach(([x, y], i) => {
      fx?.write(x, lines(6 + i, x));
      fx?.write(y, lines(6 + i, y));
      fx?.commit(`feat: step ${i}`, i + 1);
    });
    fx.write("lonely.ts", lines(9));
    fx.commit("feat: alone", 9);
    const model = buildModel(await ingest(fx.dir));
    const c = (p: string) => model.files[model.paths.indexOf(p)]?.centrality as number;
    expect(c("core.ts")).toBe(1);
    expect(c("a.ts")).toBeGreaterThan(c("b.ts"));
    // The first commit touches all five files, so the lonely file still has some coupling.
    expect(c("lonely.ts")).toBeLessThan(c("b.ts"));
  });
});

describe("time buckets", () => {
  it("uses between 8 and 128 equal-width buckets", () => {
    const day = 86400;
    expect(makeBuckets([commit([0], "", 0), commit([0], "", 3 * day)]).count).toBe(8);
    expect(makeBuckets([commit([0], "", 0), commit([0], "", 20 * 7 * day)]).count).toBe(20);
    expect(makeBuckets([commit([0], "", 0), commit([0], "", 400 * 7 * day)]).count).toBe(128);
    const b = makeBuckets([commit([0], "", 1000), commit([0], "", 1000 + 80 * 7 * day)]);
    expect(b.start[0]).toBe(1000);
    expect((b.start[1] as number) - (b.start[0] as number)).toBe(7 * day);
  });

  it("tracks cumulative height and decaying heat per file", () => {
    const day = 86400;
    const ing: IngestResult = {
      repoName: "t",
      head: "x",
      authors: [{ name: "A", email: "a@x" }],
      files: [
        { path: "hot.ts", binary: false, loc: 30, deleted: false },
        { path: "gone.ts", binary: false, loc: 0, deleted: true },
      ],
      commits: [
        {
          sha: "1",
          time: 0,
          authorIndex: 0,
          subject: "feat: add",
          changes: [
            { fileId: 0, added: 20, deleted: 0 },
            { fileId: 1, added: 10, deleted: 0 },
          ],
        },
        {
          sha: "2",
          time: 14 * day,
          authorIndex: 0,
          subject: "fix: crash",
          changes: [{ fileId: 0, added: 15, deleted: 5 }],
        },
        {
          sha: "3",
          time: 28 * day,
          authorIndex: 0,
          subject: "chore: drop",
          changes: [{ fileId: 1, added: 0, deleted: 10 }],
        },
        {
          sha: "4",
          time: 56 * day,
          authorIndex: 0,
          subject: "feat: end",
          changes: [{ fileId: 0, added: 0, deleted: 0 }],
        },
      ],
    };
    const m = buildModel(ing);
    const B = m.buckets.count;
    expect(B).toBe(8);
    const h = (f: number, t: number) => m.history[(f * B + t) * 2] as number;
    const heat = (f: number, t: number) => m.history[(f * B + t) * 2 + 1] as number;
    expect(h(0, 0)).toBe(20);
    expect(h(0, B - 1)).toBe(30);
    expect(h(1, 0)).toBe(10);
    expect(h(1, B - 1)).toBe(0);
    expect(m.files[1]).toMatchObject({ loc: 0, locMax: 10, deleted: true });
    expect(m.files[0]).toMatchObject({ loc: 30, locMax: 30, churn: 3, fixes: 1, authors: 1 });
    const fixBucket = 2;
    expect(heat(0, fixBucket - 1)).toBe(0);
    expect(heat(0, fixBucket)).toBe(65535);
    expect(heat(0, fixBucket + 1)).toBe(Math.round(0.85 * 65535));
    expect(heat(1, fixBucket)).toBe(0);
    expect(m.series.commits.reduce((a, b) => a + b, 0)).toBe(4);
    expect(m.series.fixCommits[fixBucket]).toBe(1);
  });
});
