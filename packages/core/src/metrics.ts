import type { CommitEvent, IngestResult } from "./ingest.js";

/** A commit touching more than this many files is a reformat, vendor drop or bulk rename. */
export const MASS_COMMIT_FILES = 50;
export const MIN_BUCKETS = 8;
export const MAX_BUCKETS = 128;
export const HEAT_DECAY = 0.85;
const WEEK = 7 * 24 * 3600;
const U16 = 65535;

const FIX_PREFIX = /^(fix|hotfix|bugfix)(\(.+\))?!?:/i;
const FIX_WORD = /\b(fix|fixes|fixed|bug|bugs|hotfix|regression|crash)\b/i;

export function isFixCommit(subject: string): boolean {
  return FIX_PREFIX.test(subject) || FIX_WORD.test(subject);
}

export function isMassCommit(commit: CommitEvent): boolean {
  return commit.changes.length > MASS_COMMIT_FILES;
}

export interface FileMetrics {
  loc: number;
  locMax: number;
  churn: number;
  fixes: number;
  authors: number;
  centrality: number;
  deleted: boolean;
  binary: boolean;
}

/** Weighted, undirected co-change adjacency: adj[a].get(b) is the coupling weight of a and b. */
export function coChangeGraph(fileCount: number, commits: readonly CommitEvent[]): Map<number, number>[] {
  const adj: Map<number, number>[] = Array.from({ length: fileCount }, () => new Map());
  for (const c of commits) {
    const n = c.changes.length;
    if (n < 2 || n > MASS_COMMIT_FILES) continue;
    const w = 1 / (n - 1);
    const ids = c.changes.map((ch) => ch.fileId).sort((a, b) => a - b);
    for (let i = 0; i < n; i++) {
      const a = ids[i] as number;
      const ma = adj[a] as Map<number, number>;
      for (let j = i + 1; j < n; j++) {
        const b = ids[j] as number;
        ma.set(b, (ma.get(b) ?? 0) + w);
        const mb = adj[b] as Map<number, number>;
        mb.set(a, (mb.get(a) ?? 0) + w);
      }
    }
  }
  return adj;
}

/** Weighted PageRank with uniform redistribution of dangling mass. Deterministic iteration order. */
export function pageRank(adj: readonly Map<number, number>[], damping = 0.85, iterations = 30): Float64Array {
  const n = adj.length;
  let rank = new Float64Array(n).fill(n ? 1 / n : 0);
  if (n === 0) return rank;
  const outWeight = new Float64Array(n);
  const edges: { to: Int32Array; w: Float64Array }[] = adj.map((m, i) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    const to = Int32Array.from(keys);
    const w = Float64Array.from(keys.map((k) => m.get(k) as number));
    let sum = 0;
    for (const x of w) sum += x;
    outWeight[i] = sum;
    return { to, w };
  });
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outWeight[i] === 0) dangling += rank[i] as number;
    const base = (1 - damping) / n + (damping * dangling) / n;
    const next = new Float64Array(n).fill(base);
    for (let i = 0; i < n; i++) {
      const ow = outWeight[i] as number;
      if (ow === 0) continue;
      const share = (damping * (rank[i] as number)) / ow;
      const { to, w } = edges[i] as { to: Int32Array; w: Float64Array };
      for (let k = 0; k < to.length; k++) next[to[k] as number] += share * (w[k] as number);
    }
    rank = next;
  }
  return rank;
}

/** Min-max normalise to [0, 1]; a flat input maps to all zeros. */
export function normalise(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (!(span > 0)) return out;
  for (let i = 0; i < values.length; i++) out[i] = ((values[i] as number) - min) / span;
  return out;
}

export interface Buckets {
  count: number;
  first: number;
  width: number;
  start: Uint32Array;
}

export function makeBuckets(commits: readonly CommitEvent[]): Buckets {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const c of commits) {
    if (c.time < first) first = c.time;
    if (c.time > last) last = c.time;
  }
  if (!Number.isFinite(first)) first = last = 0;
  const span = last - first;
  const weeks = Math.ceil(span / WEEK);
  const count = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, weeks));
  const width = span > 0 ? span / count : 1;
  const start = new Uint32Array(count);
  for (let t = 0; t < count; t++) start[t] = first + Math.floor(t * width);
  return { count, first, width, start };
}

export function bucketOf(b: Buckets, time: number): number {
  const t = Math.floor((time - b.first) / b.width);
  return t < 0 ? 0 : t >= b.count ? b.count - 1 : t;
}

export interface BucketSeries {
  commits: Uint32Array;
  fixCommits: Uint32Array;
  added: Float64Array;
  deleted: Float64Array;
}

export interface CityModel {
  repoName: string;
  files: FileMetrics[];
  paths: string[];
  authors: string[];
  buckets: Buckets;
  series: BucketSeries;
  /** u16 × F × B × 2, file-major, interleaved [height, heat]. */
  history: Uint16Array;
  /** Commit count per file (non-mass) per bucket, used for era titles. Flat F × B. */
  churnByBucket: Uint32Array;
  commitCount: number;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}

/** Compute per-file metrics and the bucketed history from an ingest result. */
export function buildModel(ing: IngestResult): CityModel {
  const F = ing.files.length;
  const buckets = makeBuckets(ing.commits);
  const B = buckets.count;

  const churn = new Uint32Array(F);
  const fixes = new Uint32Array(F);
  const authorSets: Set<number>[] = Array.from({ length: F }, () => new Set());
  const delta = new Float64Array(F * B);
  const fixesIn = new Uint32Array(F * B);
  const churnByBucket = new Uint32Array(F * B);
  const netTotal = new Float64Array(F);
  const series: BucketSeries = {
    commits: new Uint32Array(B),
    fixCommits: new Uint32Array(B),
    added: new Float64Array(B),
    deleted: new Float64Array(B),
  };

  for (const c of ing.commits) {
    const t = bucketOf(buckets, c.time);
    const mass = isMassCommit(c);
    const fix = !mass && isFixCommit(c.subject);
    series.commits[t] = (series.commits[t] as number) + 1;
    if (fix) series.fixCommits[t] = (series.fixCommits[t] as number) + 1;
    for (const ch of c.changes) {
      const id = ch.fileId;
      const k = id * B + t;
      delta[k] = (delta[k] as number) + ch.added - ch.deleted;
      netTotal[id] = (netTotal[id] as number) + ch.added - ch.deleted;
      series.added[t] = (series.added[t] as number) + ch.added;
      series.deleted[t] = (series.deleted[t] as number) + ch.deleted;
      (authorSets[id] as Set<number>).add(c.authorIndex);
      if (mass) continue;
      churn[id] = (churn[id] as number) + 1;
      churnByBucket[k] = (churnByBucket[k] as number) + 1;
      if (fix) {
        fixes[id] = (fixes[id] as number) + 1;
        fixesIn[k] = (fixesIn[k] as number) + 1;
      }
    }
  }

  const centrality = normalise(pageRank(coChangeGraph(F, ing.commits)));
  const history = new Uint16Array(F * B * 2);
  const rawHeat = new Float64Array(F * B);
  const files: FileMetrics[] = new Array(F);

  for (let id = 0; id < F; id++) {
    const f = ing.files[id] as (typeof ing.files)[number];
    const net = Math.max(0, netTotal[id] as number);
    const loc = f.deleted ? 0 : (f.loc ?? net);
    // History that starts before the analysed window (or a file never touched in it) gets a baseline.
    let running = f.deleted ? 0 : Math.max(0, loc - (netTotal[id] as number));
    let locMax = running;
    let heat = 0;
    for (let t = 0; t < B; t++) {
      const k = id * B + t;
      running = Math.max(0, running + (delta[k] as number));
      if (running > locMax) locMax = running;
      heat = heat * HEAT_DECAY + (fixesIn[k] as number);
      rawHeat[k] = heat;
      history[k * 2] = Math.min(U16, Math.round(running));
    }
    files[id] = {
      loc,
      locMax: Math.round(Math.max(locMax, loc)),
      churn: churn[id] as number,
      fixes: fixes[id] as number,
      authors: (authorSets[id] as Set<number>).size,
      centrality: centrality[id] as number,
      deleted: f.deleted,
      binary: f.binary,
    };
  }

  const positive = Float64Array.from(rawHeat.filter((h) => h > 0)).sort();
  const p95 = percentile(positive, 0.95);
  if (p95 > 0) {
    for (let k = 0; k < rawHeat.length; k++) {
      const v = Math.min(1, (rawHeat[k] as number) / p95);
      history[k * 2 + 1] = Math.round(v * U16);
    }
  }

  return {
    repoName: ing.repoName,
    files,
    paths: ing.files.map((f) => f.path),
    authors: ing.authors.map((a) => a.name),
    buckets,
    series,
    history,
    churnByBucket,
    commitCount: ing.commits.length,
  };
}
