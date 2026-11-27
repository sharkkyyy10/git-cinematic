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

/**
 * Binary segmentation on the mean. Repeatedly applies the single split (over all current segments)
 * with the largest squared-error reduction, as long as it removes more than MIN_GAIN of that
 * segment's error, both halves keep MIN_SEGMENT buckets and fewer than MAX_SEGMENTS exist.
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
  const segments: Segment[] = [{ start: 0, end: n - 1 }];
  while (segments.length < MAX_SEGMENTS) {
    let best: { seg: number; at: number; gain: number } | null = null;
    segments.forEach((seg, si) => {
      const total = sse(prefix, prefixSq, seg.start, seg.end);
      if (!(total > 0)) return;
      for (let at = seg.start + MIN_SEGMENT - 1; at <= seg.end - MIN_SEGMENT; at++) {
        const split = sse(prefix, prefixSq, seg.start, at) + sse(prefix, prefixSq, at + 1, seg.end);
        const gain = total - split;
        if (gain > MIN_GAIN * total && (!best || gain > best.gain + 1e-9)) best = { seg: si, at, gain };
      }
    });
    if (!best) break;
    const { seg, at } = best as { seg: number; at: number };
    const s = segments[seg] as Segment;
    segments.splice(seg, 1, { start: s.start, end: at }, { start: at + 1, end: s.end });
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
 * further while a single child holds at least half of the churn (so monorepos read as
 * `packages/viewer` rather than `packages`).
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
    let all = 0;
    paths.forEach((p, f) => {
      const parts = p.split("/");
      if (parts.length - 1 <= depth) return;
      if (prefix.some((seg, i) => parts[i] !== seg)) return;
      const key = parts[depth] as string;
      const c = churn[f] as number;
      totals.set(key, (totals.get(key) ?? 0) + c);
      all += c;
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
    if (bestKey === null || (depth > 0 && bestVal * 2 < all)) break;
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
