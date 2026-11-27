import { describe, expect, it } from "vitest";
import { busiestDir, classify, detectEras, median, segmentSeries } from "../src/eras.js";
import { EraKind } from "../src/format.js";
import type { BucketSeries } from "../src/metrics.js";

function series(commits: number[], extra: Partial<Record<keyof BucketSeries, number[]>> = {}): BucketSeries {
  const n = commits.length;
  return {
    commits: Uint32Array.from(commits),
    fixCommits: Uint32Array.from(extra.fixCommits ?? new Array(n).fill(0)),
    added: Float64Array.from(extra.added ?? new Array(n).fill(10)),
    deleted: Float64Array.from(extra.deleted ?? new Array(n).fill(1)),
  };
}

describe("segmentSeries", () => {
  it("splits at a clear change in the mean", () => {
    const segs = segmentSeries([1, 1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9]);
    expect(segs).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
  });

  it("cuts out an episode in the middle of a long segment", () => {
    // No single cut removes 15% of the error here, but cutting around the burst does.
    const series = [...new Array(40).fill(10), ...new Array(6).fill(40), ...new Array(40).fill(10)];
    expect(segmentSeries(series)).toEqual([
      { start: 0, end: 39 },
      { start: 40, end: 45 },
      { start: 46, end: 85 },
    ]);
  });

  it("does not split flat or noisy-but-flat series", () => {
    expect(segmentSeries(new Array(20).fill(4))).toEqual([{ start: 0, end: 19 }]);
  });

  it("respects the minimum length of 3 and the maximum of 8 segments", () => {
    const zigzag = Array.from({ length: 64 }, (_, i) => (Math.floor(i / 3) % 2 ? 50 : 0));
    const segs = segmentSeries(zigzag);
    expect(segs.length).toBeLessThanOrEqual(8);
    for (const s of segs) expect(s.end - s.start + 1).toBeGreaterThanOrEqual(3);
    expect(segs[0]?.start).toBe(0);
    expect(segs[segs.length - 1]?.end).toBe(63);
  });
});

describe("classify", () => {
  const seg = { start: 0, end: 3 };
  it("detects each kind in priority order", () => {
    expect(classify(series([10, 10, 10, 10], { fixCommits: [5, 5, 5, 5] }), seg, 10)).toBe(EraKind.FixWave);
    expect(classify(series([20, 20, 20, 20]), seg, 10)).toBe(EraKind.Expansion);
    expect(classify(series([5, 5, 5, 5], { added: [1, 1, 1, 1], deleted: [9, 9, 9, 9] }), seg, 10)).toBe(
      EraKind.Cleanup,
    );
    expect(classify(series([5, 5, 5, 5]), seg, 10)).toBe(EraKind.Steady);
  });
  it("computes medians", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("titles", () => {
  it("names the busiest directory, refining into a dominant child", () => {
    const paths = ["packages/viewer/a.ts", "packages/viewer/b.ts", "packages/core/c.ts", "docs/x.md", "README.md"];
    const B = 1;
    const churn = [5, 5, 1, 2, 9];
    expect(busiestDir(paths, churn, B, { start: 0, end: 0 })).toBe("packages/viewer");
    expect(busiestDir(["a.ts"], [3], 1, { start: 0, end: 0 })).toBe("(root)");
  });

  it("builds deterministic era titles", () => {
    const s = series([1, 1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9]);
    const paths = ["app/a.ts", "lib/b.ts"];
    const churn = new Uint32Array(2 * 12);
    for (let t = 0; t < 6; t++) churn[t] = 1;
    for (let t = 6; t < 12; t++) churn[12 + t] = 3;
    const eras = detectEras(s, paths, churn, 12);
    expect(eras.map((e) => e.title)).toEqual(["Steady build · app", "Expansion · lib"]);
    expect(eras.map((e) => [e.startBucket, e.endBucket])).toEqual([
      [0, 5],
      [6, 11],
    ]);
  });
});
