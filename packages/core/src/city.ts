import { detectEras } from "./eras.js";
import { type City, type CityFile, FILE_BINARY, FILE_DELETED, FLAG_TRUNCATED } from "./format.js";
import { layoutCity } from "./layout.js";
import type { CityModel, FileMetrics } from "./metrics.js";

export interface BuildOptions {
  /** Keep the files with the highest locMax; fold the rest into one building per directory. */
  maxFiles?: number;
  /** Unix seconds stored in the header. Use a value derived from the repo (not the clock) for reproducibility. */
  generatedAt: number;
}

export const OTHER_NAME = "(other)";

interface Row {
  path: string;
  m: FileMetrics;
  history: Uint16Array; // B × 2
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Fold everything outside the top `maxFiles` (by locMax) into one `<dir>/(other)` building per directory. */
export function foldFiles(rows: Row[], maxFiles: number, B: number): { rows: Row[]; truncated: boolean } {
  if (rows.length <= maxFiles) return { rows, truncated: false };
  const ranked = rows.map((r, i) => ({ r, i })).sort((a, b) => b.r.m.locMax - a.r.m.locMax || byPath(a.r, b.r));
  const keep = new Set(ranked.slice(0, maxFiles).map((x) => x.i));
  const kept: Row[] = [];
  const folded = new Map<string, Row>();
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      kept.push(r);
      return;
    }
    const dir = dirOf(r.path);
    const path = dir ? `${dir}/${OTHER_NAME}` : OTHER_NAME;
    let o = folded.get(path);
    if (!o) {
      o = {
        path,
        m: { loc: 0, locMax: 0, churn: 0, fixes: 0, authors: 0, centrality: 0, deleted: true, binary: false },
        history: new Uint16Array(B * 2),
      };
      folded.set(path, o);
    }
    o.m.loc += r.m.loc;
    o.m.locMax += r.m.locMax;
    o.m.churn += r.m.churn;
    o.m.fixes += r.m.fixes;
    o.m.authors = Math.max(o.m.authors, r.m.authors);
    o.m.centrality = Math.max(o.m.centrality, r.m.centrality);
    o.m.deleted = o.m.deleted && r.m.deleted;
    for (let t = 0; t < B; t++) {
      o.history[t * 2] = Math.min(65535, (o.history[t * 2] as number) + (r.history[t * 2] as number));
      o.history[t * 2 + 1] = Math.max(o.history[t * 2 + 1] as number, r.history[t * 2 + 1] as number);
    }
  });
  return { rows: [...kept, ...[...folded.values()].sort(byPath)], truncated: true };
}

/** Turn computed metrics into a laid-out city ready to encode. */
export function buildCity(model: CityModel, opts: BuildOptions): City {
  const B = model.buckets.count;
  let rows: Row[] = model.files.map((m, i) => ({
    path: model.paths[i] as string,
    m,
    history: model.history.subarray(i * B * 2, (i + 1) * B * 2),
  }));
  let truncated = false;
  if (opts.maxFiles !== undefined) ({ rows, truncated } = foldFiles(rows, opts.maxFiles, B));

  const eras = detectEras(model.series, model.paths, model.churnByBucket, B);
  const layout = layoutCity(
    rows.map((r) => r.path),
    rows.map((r) => r.m.locMax),
  );
  const history = new Uint16Array(rows.length * B * 2);
  rows.forEach((r, i) => {
    history.set(r.history, i * B * 2);
  });
  const files: CityFile[] = rows.map((r, i) => {
    const box = layout.files[i] as { x: number; z: number; w: number; d: number };
    return {
      path: r.path,
      ...box,
      loc: r.m.loc,
      locMax: r.m.locMax,
      churn: r.m.churn,
      fixes: r.m.fixes,
      centrality: r.m.centrality,
      authors: r.m.authors,
      flags: (r.m.deleted ? FILE_DELETED : 0) | (r.m.binary ? FILE_BINARY : 0),
    };
  });
  return {
    flags: truncated ? FLAG_TRUNCATED : 0,
    generatedAt: opts.generatedAt,
    repoName: model.repoName,
    bucketStart: model.buckets.start,
    files,
    dirs: layout.dirs,
    authors: model.authors,
    eras,
    history,
  };
}
