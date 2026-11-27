// city.bin v1: encoder and decoder. Browser-safe (no Node imports); gzip is handled by callers.
// The layout is specified in docs/CITY_FORMAT.md.

export const MAGIC = "GCTY";
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 40;
export const FILE_RECORD_BYTES = 40;
export const DIR_RECORD_BYTES = 20;
export const ERA_RECORD_BYTES = 12;
export const MAX_DECODE_FILES = 200_000;
export const MAX_DECODE_BUCKETS = 1024;
export const MAX_CITY_BYTES = 64 * 1024 * 1024;

export const FLAG_TRUNCATED = 1;
export const FILE_DELETED = 1;
export const FILE_BINARY = 2;

export const EraKind = { Steady: 0, Expansion: 1, FixWave: 2, Cleanup: 3 } as const;
export type EraKind = (typeof EraKind)[keyof typeof EraKind];
export const ERA_KIND_NAMES = ["Steady build", "Expansion", "Fix wave", "Cleanup"] as const;

export interface CityFile {
  path: string;
  x: number;
  z: number;
  w: number;
  d: number;
  loc: number;
  locMax: number;
  churn: number;
  fixes: number;
  centrality: number;
  authors: number;
  flags: number;
}

export interface CityDir {
  path: string;
  x: number;
  z: number;
  w: number;
  d: number;
  depth: number;
}

export interface CityEra {
  title: string;
  startBucket: number;
  endBucket: number;
  kind: EraKind;
}

export interface City {
  flags: number;
  generatedAt: number;
  repoName: string;
  bucketStart: Uint32Array;
  files: CityFile[];
  dirs: CityDir[];
  authors: string[];
  eras: CityEra[];
  /** u16 × F × B × 2, file-major then bucket, interleaved [height, heat]. */
  history: Uint16Array;
}

export class CityFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CityFormatError";
  }
}

const pad4 = (n: number) => (n + 3) & ~3;

function stringTable(city: City): Uint8Array {
  const parts = [
    city.repoName,
    ...city.files.map((f) => f.path),
    ...city.dirs.map((d) => d.path),
    ...city.authors,
    ...city.eras.map((e) => e.title),
  ];
  for (const s of parts) if (s.includes("\0")) throw new CityFormatError("strings must not contain NUL");
  return new TextEncoder().encode(parts.join("\0"));
}

interface Layout {
  strings: number;
  bucketStart: number;
  files: number;
  dirs: number;
  eras: number;
  history: number;
  total: number;
}

function layout(F: number, D: number, B: number, E: number, S: number): Layout {
  const strings = HEADER_BYTES;
  const bucketStart = strings + pad4(S);
  const files = bucketStart + 4 * B;
  const dirs = files + FILE_RECORD_BYTES * F;
  const eras = dirs + DIR_RECORD_BYTES * D;
  const history = eras + ERA_RECORD_BYTES * E;
  const total = history + pad4(2 * F * B * 2);
  return { strings, bucketStart, files, dirs, eras, history, total };
}

/** Serialise a city to uncompressed bytes. Deterministic for identical input. */
export function encodeCity(city: City): Uint8Array {
  const F = city.files.length;
  const D = city.dirs.length;
  const B = city.bucketStart.length;
  const A = city.authors.length;
  const E = city.eras.length;
  if (city.history.length !== F * B * 2) throw new CityFormatError("history length does not match F × B × 2");
  const strings = stringTable(city);
  const L = layout(F, D, B, E, strings.length);
  const buf = new Uint8Array(L.total);
  const v = new DataView(buf.buffer);

  buf.set(new TextEncoder().encode(MAGIC), 0);
  v.setUint16(4, FORMAT_VERSION, true);
  v.setUint16(6, city.flags, true);
  v.setUint32(8, F, true);
  v.setUint32(12, D, true);
  v.setUint32(16, B, true);
  v.setUint32(20, A, true);
  v.setUint32(24, E, true);
  v.setUint32(28, strings.length, true);
  v.setUint32(32, city.generatedAt >>> 0, true);
  v.setUint32(36, 0, true);
  buf.set(strings, L.strings);

  for (let t = 0; t < B; t++) v.setUint32(L.bucketStart + 4 * t, city.bucketStart[t] as number, true);
  city.files.forEach((f, i) => {
    const o = L.files + i * FILE_RECORD_BYTES;
    v.setFloat32(o, f.x, true);
    v.setFloat32(o + 4, f.z, true);
    v.setFloat32(o + 8, f.w, true);
    v.setFloat32(o + 12, f.d, true);
    v.setUint32(o + 16, f.loc >>> 0, true);
    v.setUint32(o + 20, f.locMax >>> 0, true);
    v.setUint32(o + 24, f.churn >>> 0, true);
    v.setUint32(o + 28, f.fixes >>> 0, true);
    v.setFloat32(o + 32, f.centrality, true);
    v.setUint16(o + 36, Math.min(65535, f.authors), true);
    v.setUint16(o + 38, f.flags, true);
  });
  city.dirs.forEach((d, i) => {
    const o = L.dirs + i * DIR_RECORD_BYTES;
    v.setFloat32(o, d.x, true);
    v.setFloat32(o + 4, d.z, true);
    v.setFloat32(o + 8, d.w, true);
    v.setFloat32(o + 12, d.d, true);
    v.setUint16(o + 16, d.depth, true);
    v.setUint16(o + 18, 0, true);
  });
  city.eras.forEach((e, i) => {
    const o = L.eras + i * ERA_RECORD_BYTES;
    v.setUint32(o, e.startBucket, true);
    v.setUint32(o + 4, e.endBucket, true);
    v.setUint32(o + 8, e.kind, true);
  });
  for (let k = 0; k < city.history.length; k++) v.setUint16(L.history + 2 * k, city.history[k] as number, true);
  return buf;
}

/** Parse uncompressed city bytes. Validates sizes before allocating anything large. */
export function decodeCity(bytes: Uint8Array): City {
  if (bytes.byteLength > MAX_CITY_BYTES) throw new CityFormatError("city file is larger than 64 MB");
  if (bytes.byteLength < HEADER_BYTES) throw new CityFormatError("city file is truncated (no header)");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0] as number, bytes[1] as number, bytes[2] as number, bytes[3] as number);
  if (magic !== MAGIC) throw new CityFormatError("not a city file (bad magic)");
  const version = v.getUint16(4, true);
  if (version !== FORMAT_VERSION) throw new CityFormatError(`unsupported city format version ${version}`);
  const flags = v.getUint16(6, true);
  const F = v.getUint32(8, true);
  const D = v.getUint32(12, true);
  const B = v.getUint32(16, true);
  const A = v.getUint32(20, true);
  const E = v.getUint32(24, true);
  const S = v.getUint32(28, true);
  const generatedAt = v.getUint32(32, true);
  if (F > MAX_DECODE_FILES) throw new CityFormatError(`too many files (${F})`);
  if (B > MAX_DECODE_BUCKETS) throw new CityFormatError(`too many buckets (${B})`);
  if (D > MAX_DECODE_FILES || A > MAX_DECODE_FILES || E > MAX_DECODE_BUCKETS || S > MAX_CITY_BYTES) {
    throw new CityFormatError("header counts are out of range");
  }
  const L = layout(F, D, B, E, S);
  if (L.total !== bytes.byteLength) {
    throw new CityFormatError(
      L.total > bytes.byteLength ? "city file is truncated" : "city file has trailing bytes (size mismatch)",
    );
  }

  const table = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(L.strings, L.strings + S));
  const strings = table.split("\0");
  const expected = 1 + F + D + A + E;
  if (strings.length !== expected) {
    throw new CityFormatError(`string table has ${strings.length} entries, expected ${expected}`);
  }
  let si = 0;
  const next = () => strings[si++] as string;
  const repoName = next();

  const bucketStart = new Uint32Array(B);
  for (let t = 0; t < B; t++) bucketStart[t] = v.getUint32(L.bucketStart + 4 * t, true);

  const files: CityFile[] = new Array(F);
  for (let i = 0; i < F; i++) {
    const o = L.files + i * FILE_RECORD_BYTES;
    files[i] = {
      path: next(),
      x: v.getFloat32(o, true),
      z: v.getFloat32(o + 4, true),
      w: v.getFloat32(o + 8, true),
      d: v.getFloat32(o + 12, true),
      loc: v.getUint32(o + 16, true),
      locMax: v.getUint32(o + 20, true),
      churn: v.getUint32(o + 24, true),
      fixes: v.getUint32(o + 28, true),
      centrality: v.getFloat32(o + 32, true),
      authors: v.getUint16(o + 36, true),
      flags: v.getUint16(o + 38, true),
    };
  }
  const dirs: CityDir[] = new Array(D);
  for (let i = 0; i < D; i++) {
    const o = L.dirs + i * DIR_RECORD_BYTES;
    dirs[i] = {
      path: next(),
      x: v.getFloat32(o, true),
      z: v.getFloat32(o + 4, true),
      w: v.getFloat32(o + 8, true),
      d: v.getFloat32(o + 12, true),
      depth: v.getUint16(o + 16, true),
    };
  }
  const authors: string[] = new Array(A);
  for (let i = 0; i < A; i++) authors[i] = next();
  const eras: CityEra[] = new Array(E);
  for (let i = 0; i < E; i++) {
    const o = L.eras + i * ERA_RECORD_BYTES;
    const startBucket = v.getUint32(o, true);
    const endBucket = v.getUint32(o + 4, true);
    const kind = v.getUint32(o + 8, true);
    if (kind > 3) throw new CityFormatError(`unknown era kind ${kind}`);
    if (startBucket > endBucket || endBucket >= Math.max(B, 1)) throw new CityFormatError("era is out of range");
    eras[i] = { title: next(), startBucket, endBucket, kind: kind as EraKind };
  }
  const history = new Uint16Array(F * B * 2);
  for (let k = 0; k < history.length; k++) history[k] = v.getUint16(L.history + 2 * k, true);

  return { flags, generatedAt, repoName, bucketStart, files, dirs, authors, eras, history };
}

/** Rank-percentile in [0, 1] (ties share the average rank). */
export function rankPercentile(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => (values[a] as number) - (values[b] as number));
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1] as number] === values[idx[i] as number]) j++;
    const p = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k] as number] = p;
    i = j + 1;
  }
  return out;
}

export interface Hotspot {
  index: number;
  score: number;
}

/** Hotspot score = norm(churn) × norm(loc), ranked descending. Deleted and untouched files score 0. */
export function hotspots(files: readonly Pick<CityFile, "churn" | "loc" | "flags" | "path">[]): Hotspot[] {
  const churn = rankPercentile(files.map((f) => f.churn));
  const loc = rankPercentile(files.map((f) => f.loc));
  return files
    .map((f, index) => ({
      index,
      score:
        f.flags & FILE_DELETED || f.churn === 0 || f.loc === 0 ? 0 : (churn[index] as number) * (loc[index] as number),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
