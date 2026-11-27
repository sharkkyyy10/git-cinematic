import { ERA_KIND_NAMES, EraKind } from "./format.js";
import type { BucketSeries } from "./metrics.js";

export const MIN_SEGMENT = 3;
export const MAX_SEGMENTS = 8;
export const MIN_GAIN = 0.15;

export interface Segment {
  start: number;
  /** Inclusive. */
  end: number;
}

function sse(prefix: Float64Array, prefixSq: Float64Array, s: number, e: number): number {
  const n = e - s + 1;
  const sum = (prefix[e + 1] as number) - (prefix[s] as number);
  const sq = (prefixSq[e + 1] as number) - (prefixSq[s] as number);
  return sq - (sum * sum) / n;
}

interface Split {
  seg: number;
  /** Cut points: the segment ends after each one (one cut = binary split, two = middle block). */
  cuts: number[];
  gain: number;
}

/**
 * Binary segmentation on the mean. Repeatedly applies the split (over all current segments) with
 * the largest squared-error reduction, as long as it removes more than MIN_GAIN of that segment's
 * error, every part keeps MIN_SEGMENT buckets and at most MAX_SEGMENTS exist.
 *
 * When no single cut of a segment qualifies, the segment may instead be cut around a middle block
 * (circular binary segmentation). Plain binary segmentation misses an episode in the middle of a
 * long segment: neither cut alone explains enough of the error, though both together do.
 */
export function segmentSeries(series: ArrayLike<number>): Segment[] {
  const n = series.length;
  if (n === 0) return [];
  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const x = series[i] as number;
    prefix[i + 1] = (prefix[i] as number) + x;
    prefixSq[i + 1] = (prefixSq[i] as number) + x * x;
  }
  const err = (s: number, e: number) => sse(prefix, prefixSq, s, e);
  const segments: Segment[] = [{ start: 0, end: n - 1 }];
  while (segments.length < MAX_SEGMENTS) {
    let best: Split | null = null;
    const consider = (cand: Split) => {
      if (!best || cand.gain > best.gain + 1e-9) best = cand;
    };
    segments.forEach((seg, si) => {
      const total = err(seg.start, seg.end);
      if (!(total > 0)) return;
      let single: Split | null = null;
      for (let at = seg.start + MIN_SEGMENT - 1; at <= seg.end - MIN_SEGMENT; at++) {
        const gain = total - err(seg.start, at) - err(at + 1, seg.end);
        if (gain > MIN_GAIN * total && (!single || gain > single.gain + 1e-9)) single = { seg: si, cuts: [at], gain };
      }
      if (single) {
        consider(single);
        return;
      }
      if (segments.length + 2 > MAX_SEGMENTS) return;
      let block: Split | null = null;
      for (let a = seg.start + MIN_SEGMENT - 1; a <= seg.end - 2 * MIN_SEGMENT; a++) {
        for (let b = a + MIN_SEGMENT; b <= seg.end - MIN_SEGMENT; b++) {
          const gain = total - err(seg.start, a) - err(a + 1, b) - err(b + 1, seg.end);
          if (gain > MIN_GAIN * total && (!block || gain > block.gain + 1e-9)) block = { seg: si, cuts: [a, b], gain };
        }
      }
      if (block) consider(block);
    });
    if (!best) break;
    const { seg, cuts } = best as Split;
    const s = segments[seg] as Segment;
    const parts: Segment[] = [];
    let start = s.start;
    for (const c of cuts) {
      parts.push({ start, end: c });
      start = c + 1;
    }
    parts.push({ start, end: s.end });
    segments.splice(seg, 1, ...parts);
  }
  return segments;
}

export function median(values: ArrayLike<number>): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function classify(series: BucketSeries, seg: Segment, activityMedian: number): EraKind {
  let commits = 0;
  let fixes = 0;
  let added = 0;
  let deleted = 0;
  for (let t = seg.start; t <= seg.end; t++) {
    commits += series.commits[t] as number;
    fixes += series.fixCommits[t] as number;
    added += series.added[t] as number;
    deleted += series.deleted[t] as number;
  }
  const activity = commits / (seg.end - seg.start + 1);
  if (commits > 0 && fixes / commits > 0.4) return EraKind.FixWave;
  if (activity > 1.5 * activityMedian) return EraKind.Expansion;
  if (deleted > added) return EraKind.Cleanup;
  return EraKind.Steady;
}

/**
 * The directory with the most churn inside a segment: the top-level directory, refined one level
 * further into its busiest child, so monorepos read as `packages/viewer` rather than `packages`.
 */
export function busiestDir(
  paths: readonly string[],
  churnByBucket: ArrayLike<number>,
  bucketCount: number,
  seg: Segment,
  maxDepth = 2,
): string {
  const churn = new Float64Array(paths.length);
  for (let f = 0; f < paths.length; f++) {
    let c = 0;
    for (let t = seg.start; t <= seg.end; t++) c += churnByBucket[f * bucketCount + t] as number;
    churn[f] = c;
  }
  let prefix: string[] = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    const totals = new Map<string, number>();
    paths.forEach((p, f) => {
      const parts = p.split("/");
      if (parts.length - 1 <= depth) return;
      if (prefix.some((seg, i) => parts[i] !== seg)) return;
      const key = parts[depth] as string;
      const c = churn[f] as number;
      totals.set(key, (totals.get(key) ?? 0) + c);
    });
    let bestKey: string | null = null;
    let bestVal = 0;
    for (const key of [...totals.keys()].sort()) {
      const val = totals.get(key) as number;
      if (val > bestVal) {
        bestVal = val;
        bestKey = key;
      }
    }
    if (bestKey === null) break;
    prefix = [...prefix, bestKey];
  }
  return prefix.length ? prefix.join("/") : "(root)";
}

export interface Era {
  startBucket: number;
  endBucket: number;
  kind: EraKind;
  title: string;
}

export function detectEras(
  series: BucketSeries,
  paths: readonly string[],
  churnByBucket: ArrayLike<number>,
  bucketCount: number,
): Era[] {
  const segments = segmentSeries(series.commits);
  // A sparse history has a median of zero; fall back to the median of the active buckets.
  let activityMedian = median(series.commits);
  if (activityMedian === 0) activityMedian = median(Array.from(series.commits).filter((c) => c > 0));
  const eras: Era[] = [];
  for (const seg of segments) {
    const kind = classify(series, seg, activityMedian);
    const dir = busiestDir(paths, churnByBucket, bucketCount, seg);
    const title = `${ERA_KIND_NAMES[kind]} · ${dir}`;
    const prev = eras[eras.length - 1];
    if (prev && prev.title === title) prev.endBucket = seg.end;
    else eras.push({ startBucket: seg.start, endBucket: seg.end, kind, title });
  }
  return eras;
}
