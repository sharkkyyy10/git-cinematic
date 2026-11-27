#!/usr/bin/env node

// ../core/dist/format.js
var MAGIC = "GCTY";
var FORMAT_VERSION = 1;
var HEADER_BYTES = 40;
var FILE_RECORD_BYTES = 40;
var DIR_RECORD_BYTES = 20;
var ERA_RECORD_BYTES = 12;
var MAX_CITY_BYTES = 64 * 1024 * 1024;
var FLAG_TRUNCATED = 1;
var FILE_DELETED = 1;
var FILE_BINARY = 2;
var EraKind = { Steady: 0, Expansion: 1, FixWave: 2, Cleanup: 3 };
var ERA_KIND_NAMES = ["Steady build", "Expansion", "Fix wave", "Cleanup"];
var CityFormatError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CityFormatError";
  }
};
var pad4 = (n) => n + 3 & ~3;
function stringTable(city) {
  const parts = [
    city.repoName,
    ...city.files.map((f) => f.path),
    ...city.dirs.map((d) => d.path),
    ...city.authors,
    ...city.eras.map((e) => e.title)
  ];
  for (const s of parts)
    if (s.includes("\0"))
      throw new CityFormatError("strings must not contain NUL");
  return new TextEncoder().encode(parts.join("\0"));
}
function layout(F, D, B, E, S) {
  const strings = HEADER_BYTES;
  const bucketStart = strings + pad4(S);
  const files = bucketStart + 4 * B;
  const dirs = files + FILE_RECORD_BYTES * F;
  const eras = dirs + DIR_RECORD_BYTES * D;
  const history = eras + ERA_RECORD_BYTES * E;
  const total = history + pad4(2 * F * B * 2);
  return { strings, bucketStart, files, dirs, eras, history, total };
}
function encodeCity(city) {
  const F = city.files.length;
  const D = city.dirs.length;
  const B = city.bucketStart.length;
  const A = city.authors.length;
  const E = city.eras.length;
  if (city.history.length !== F * B * 2)
    throw new CityFormatError("history length does not match F \xD7 B \xD7 2");
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
  for (let t = 0; t < B; t++)
    v.setUint32(L.bucketStart + 4 * t, city.bucketStart[t], true);
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
  for (let k = 0; k < city.history.length; k++)
    v.setUint16(L.history + 2 * k, city.history[k], true);
  return buf;
}
function rankPercentile(values) {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0)
    return out;
  const idx = Array.from({ length: n }, (_, i2) => i2).sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]])
      j++;
    const p = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++)
      out[idx[k]] = p;
    i = j + 1;
  }
  return out;
}
function hotspots(files) {
  const churn = rankPercentile(files.map((f) => f.churn));
  const loc = rankPercentile(files.map((f) => f.loc));
  return files.map((f, index) => ({
    index,
    score: f.flags & FILE_DELETED || f.churn === 0 || f.loc === 0 ? 0 : churn[index] * loc[index]
  })).sort((a, b) => b.score - a.score || a.index - b.index);
}

// ../core/dist/eras.js
var MIN_SEGMENT = 3;
var MAX_SEGMENTS = 8;
var MIN_GAIN = 0.15;
function sse(prefix, prefixSq, s, e) {
  const n = e - s + 1;
  const sum = prefix[e + 1] - prefix[s];
  const sq = prefixSq[e + 1] - prefixSq[s];
  return sq - sum * sum / n;
}
function segmentSeries(series) {
  const n = series.length;
  if (n === 0)
    return [];
  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const x = series[i];
    prefix[i + 1] = prefix[i] + x;
    prefixSq[i + 1] = prefixSq[i] + x * x;
  }
  const err = (s, e) => sse(prefix, prefixSq, s, e);
  const segments = [{ start: 0, end: n - 1 }];
  while (segments.length < MAX_SEGMENTS) {
    let best = null;
    const consider = (cand) => {
      if (!best || cand.gain > best.gain + 1e-9)
        best = cand;
    };
    segments.forEach((seg2, si) => {
      const total = err(seg2.start, seg2.end);
      if (!(total > 0))
        return;
      let single = null;
      for (let at = seg2.start + MIN_SEGMENT - 1; at <= seg2.end - MIN_SEGMENT; at++) {
        const gain = total - err(seg2.start, at) - err(at + 1, seg2.end);
        if (gain > MIN_GAIN * total && (!single || gain > single.gain + 1e-9))
          single = { seg: si, cuts: [at], gain };
      }
      if (single) {
        consider(single);
        return;
      }
      if (segments.length + 2 > MAX_SEGMENTS)
        return;
      let block = null;
      for (let a = seg2.start + MIN_SEGMENT - 1; a <= seg2.end - 2 * MIN_SEGMENT; a++) {
        for (let b = a + MIN_SEGMENT; b <= seg2.end - MIN_SEGMENT; b++) {
          const gain = total - err(seg2.start, a) - err(a + 1, b) - err(b + 1, seg2.end);
          if (gain > MIN_GAIN * total && (!block || gain > block.gain + 1e-9))
            block = { seg: si, cuts: [a, b], gain };
        }
      }
      if (block)
        consider(block);
    });
    if (!best)
      break;
    const { seg, cuts } = best;
    const s = segments[seg];
    const parts = [];
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
function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (sorted.length === 0)
    return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function classify(series, seg, activityMedian) {
  let commits = 0;
  let fixes = 0;
  let added = 0;
  let deleted = 0;
  for (let t = seg.start; t <= seg.end; t++) {
    commits += series.commits[t];
    fixes += series.fixCommits[t];
    added += series.added[t];
    deleted += series.deleted[t];
  }
  const activity = commits / (seg.end - seg.start + 1);
  if (commits > 0 && fixes / commits > 0.4)
    return EraKind.FixWave;
  if (activity > 1.5 * activityMedian)
    return EraKind.Expansion;
  if (deleted > added)
    return EraKind.Cleanup;
  return EraKind.Steady;
}
function busiestDir(paths, churnByBucket, bucketCount, seg, maxDepth = 2) {
  const churn = new Float64Array(paths.length);
  for (let f = 0; f < paths.length; f++) {
    let c = 0;
    for (let t = seg.start; t <= seg.end; t++)
      c += churnByBucket[f * bucketCount + t];
    churn[f] = c;
  }
  let prefix = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    const totals = /* @__PURE__ */ new Map();
    paths.forEach((p, f) => {
      const parts = p.split("/");
      if (parts.length - 1 <= depth)
        return;
      if (prefix.some((seg2, i) => parts[i] !== seg2))
        return;
      const key = parts[depth];
      const c = churn[f];
      totals.set(key, (totals.get(key) ?? 0) + c);
    });
    let bestKey = null;
    let bestVal = 0;
    for (const key of [...totals.keys()].sort()) {
      const val = totals.get(key);
      if (val > bestVal) {
        bestVal = val;
        bestKey = key;
      }
    }
    if (bestKey === null)
      break;
    prefix = [...prefix, bestKey];
  }
  return prefix.length ? prefix.join("/") : "(root)";
}
function detectEras(series, paths, churnByBucket, bucketCount) {
  const segments = segmentSeries(series.commits);
  let activityMedian = median(series.commits);
  if (activityMedian === 0)
    activityMedian = median(Array.from(series.commits).filter((c) => c > 0));
  const eras = [];
  for (const seg of segments) {
    const kind = classify(series, seg, activityMedian);
    const dir = busiestDir(paths, churnByBucket, bucketCount, seg);
    const title = `${ERA_KIND_NAMES[kind]} \xB7 ${dir}`;
    const prev = eras[eras.length - 1];
    if (prev && prev.title === title)
      prev.endBucket = seg.end;
    else
      eras.push({ startBucket: seg.start, endBucket: seg.end, kind, title });
  }
  return eras;
}

// ../core/dist/layout.js
var CITY_SIZE = 1e3;
var FOOTPRINT_SHRINK = 0.15;
var STREETS = [0, 4, 2, 1, 0.5];
function fileWeight(locMax) {
  return Math.sqrt(Math.max(locMax, 1)) + 1;
}
function streetInset(depth) {
  if (depth <= 0)
    return 0;
  return STREETS[Math.min(depth, 4)];
}
function buildTree(paths, weights) {
  const root = { name: "", path: "", weight: 0, file: -1, children: [] };
  const dirIndex = /* @__PURE__ */ new Map([["", root]]);
  paths.forEach((p, i) => {
    const parts = p.split("/");
    let parent = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const dirPath = parts.slice(0, k + 1).join("/");
      let dir = dirIndex.get(dirPath);
      if (!dir) {
        dir = { name: parts[k], path: dirPath, weight: 0, file: -1, children: [] };
        dirIndex.set(dirPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({
      name: parts[parts.length - 1],
      path: p,
      weight: weights[i],
      file: i,
      children: []
    });
  });
  const sum = (n) => {
    if (n.file >= 0)
      return n.weight;
    n.weight = n.children.reduce((s, c) => s + sum(c), 0);
    n.children.sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return n.weight;
  };
  sum(root);
  return root;
}
function worst(row, side) {
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const a of row) {
    sum += a;
    if (a > max)
      max = a;
    if (a < min)
      min = a;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max(s2 * max / sum2, sum2 / (s2 * min));
}
function squarify(areas, rect) {
  const out = new Array(areas.length);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) {
      row.push(areas[j]);
      j++;
    }
    const rowSum = row.reduce((s, a) => s + a, 0);
    if (w >= h) {
      const colW = h > 0 ? rowSum / h : 0;
      let cy = y;
      row.forEach((a, k) => {
        const ch = colW > 0 ? a / colW : 0;
        out[i + k] = { x, y: cy, w: colW, h: ch };
        cy += ch;
      });
      x += colW;
      w -= colW;
    } else {
      const rowH = w > 0 ? rowSum / w : 0;
      let cx = x;
      row.forEach((a, k) => {
        const cw = rowH > 0 ? a / rowH : 0;
        out[i + k] = { x: cx, y, w: cw, h: rowH };
        cx += cw;
      });
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
  return out;
}
function inset(r, amount) {
  const a = Math.min(amount, r.w / 4, r.h / 4);
  return { x: r.x + a, y: r.y + a, w: r.w - 2 * a, h: r.h - 2 * a };
}
function layoutCity(paths, locMax) {
  const weights = locMax.map(fileWeight);
  const root = buildTree(paths, weights);
  const files = new Array(paths.length);
  const dirs = [];
  const half = CITY_SIZE / 2;
  const toBox = (r) => ({ x: r.x + r.w / 2 - half, z: r.y + r.h / 2 - half, w: r.w, d: r.h });
  const place = (node, cell, depth) => {
    if (node.file >= 0) {
      const k = 1 - FOOTPRINT_SHRINK;
      const b = toBox(cell);
      files[node.file] = { x: b.x, z: b.z, w: b.w * k, d: b.d * k };
      return;
    }
    if (depth > 0)
      dirs.push({ path: node.path, depth, ...toBox(cell) });
    const inner = inset(cell, streetInset(depth));
    const area = inner.w * inner.h;
    const total = node.weight;
    if (node.children.length === 0 || total <= 0)
      return;
    const areas = node.children.map((c) => c.weight / total * area);
    const cells = squarify(areas, inner);
    node.children.forEach((c, k) => {
      place(c, cells[k], depth + 1);
    });
  };
  place(root, { x: 0, y: 0, w: CITY_SIZE, h: CITY_SIZE }, 0);
  dirs.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, dirs };
}

// ../core/dist/city.js
var OTHER_NAME = "(other)";
var byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
function foldFiles(rows, maxFiles, B) {
  if (rows.length <= maxFiles)
    return { rows, truncated: false };
  const ranked = rows.map((r, i) => ({ r, i })).sort((a, b) => b.r.m.locMax - a.r.m.locMax || byPath(a.r, b.r));
  const keep = new Set(ranked.slice(0, maxFiles).map((x) => x.i));
  const kept = [];
  const folded = /* @__PURE__ */ new Map();
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
        history: new Uint16Array(B * 2)
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
      o.history[t * 2] = Math.min(65535, o.history[t * 2] + r.history[t * 2]);
      o.history[t * 2 + 1] = Math.max(o.history[t * 2 + 1], r.history[t * 2 + 1]);
    }
  });
  return { rows: [...kept, ...[...folded.values()].sort(byPath)], truncated: true };
}
function buildCity(model, opts) {
  const B = model.buckets.count;
  let rows = model.files.map((m, i) => ({
    path: model.paths[i],
    m,
    history: model.history.subarray(i * B * 2, (i + 1) * B * 2)
  }));
  let truncated = false;
  if (opts.maxFiles !== void 0)
    ({ rows, truncated } = foldFiles(rows, opts.maxFiles, B));
  const eras = detectEras(model.series, model.paths, model.churnByBucket, B);
  const layout2 = layoutCity(rows.map((r) => r.path), rows.map((r) => r.m.locMax));
  const history = new Uint16Array(rows.length * B * 2);
  rows.forEach((r, i) => {
    history.set(r.history, i * B * 2);
  });
  const files = rows.map((r, i) => {
    const box = layout2.files[i];
    return {
      path: r.path,
      ...box,
      loc: r.m.loc,
      locMax: r.m.locMax,
      churn: r.m.churn,
      fixes: r.m.fixes,
      centrality: r.m.centrality,
      authors: r.m.authors,
      flags: (r.m.deleted ? FILE_DELETED : 0) | (r.m.binary ? FILE_BINARY : 0)
    };
  });
  return {
    flags: truncated ? FLAG_TRUNCATED : 0,
    generatedAt: opts.generatedAt,
    repoName: model.repoName,
    bucketStart: model.buckets.start,
    files,
    dirs: layout2.dirs,
    authors: model.authors,
    eras,
    history
  };
}

// ../core/dist/git.js
import { spawn } from "node:child_process";
var GitError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "GitError";
  }
};
function git(repo, args, input) {
  return new Promise((resolve3, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      reject(new GitError(e.code === "ENOENT" ? "GIT_MISSING" : "GIT_FAILED", `could not run git: ${e.message}`));
    });
    child.on("close", (code) => {
      if (code === 0)
        resolve3(Buffer.concat(out));
      else
        reject(new GitError("GIT_FAILED", Buffer.concat(err).toString("utf8").trim() || `git exited with ${code}`));
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
async function resolveRepo(repo) {
  let root;
  try {
    root = (await git(repo, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  } catch (e) {
    if (e instanceof GitError && e.code === "GIT_MISSING")
      throw e;
    throw new GitError("NOT_A_REPO", `${repo} is not inside a git repository`);
  }
  try {
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).toString("utf8").trim();
    return { root, head };
  } catch {
    throw new GitError("NO_COMMITS", `${root} has no commits yet`);
  }
}
async function headTime(repo) {
  const out = (await git(repo, ["show", "-s", "--format=%ct", "HEAD"])).toString("utf8").trim();
  return Number.parseInt(out, 10) || 0;
}

// ../core/dist/gzip.js
import { gunzipSync, gzipSync } from "node:zlib";
function packCity(city) {
  const gz = gzipSync(encodeCity(city), { level: 9 });
  gz[9] = 255;
  return gz;
}

// ../core/dist/ingest.js
import { spawn as spawn2 } from "node:child_process";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
var RS = "";
var US = "";
var MAX_COUNTED_BLOB = 2 * 1024 * 1024;
var BINARY_SNIFF = 8e3;
var LogParser = class {
  commits = [];
  authors = [];
  /** Current path → file id. A rename moves the id to the new path. */
  pathToId = /* @__PURE__ */ new Map();
  /** Latest path per file id. */
  idToPath = [];
  binary = [];
  authorByEmail = /* @__PURE__ */ new Map();
  current = null;
  pendingRename = null;
  rest = "";
  decoder = new StringDecoder("utf8");
  push(chunk) {
    const text = this.rest + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    let start = 0;
    for (let i = text.indexOf("\0"); i !== -1; i = text.indexOf("\0", start)) {
      this.token(text.slice(start, i));
      start = i + 1;
    }
    this.rest = text.slice(start);
  }
  end() {
    const tail = this.rest + this.decoder.end();
    this.rest = "";
    if (tail.length > 0)
      this.token(tail);
    this.flush();
    return this.commits;
  }
  token(raw) {
    if (this.pendingRename) {
      const p = this.pendingRename;
      if (p.old === void 0) {
        p.old = raw;
        return;
      }
      this.pendingRename = null;
      this.rename(p.old, raw, p.added, p.deleted, p.bin);
      return;
    }
    const tok = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (tok.length === 0)
      return;
    if (tok.startsWith(RS)) {
      this.flush();
      this.header(tok.slice(1));
      return;
    }
    const t1 = tok.indexOf("	");
    const t2 = t1 === -1 ? -1 : tok.indexOf("	", t1 + 1);
    if (t2 === -1 || !this.current)
      return;
    const a = tok.slice(0, t1);
    const d = tok.slice(t1 + 1, t2);
    const path = tok.slice(t2 + 1);
    const bin = a === "-" || d === "-";
    const added = bin ? 0 : Number.parseInt(a, 10) || 0;
    const deleted = bin ? 0 : Number.parseInt(d, 10) || 0;
    if (path.length === 0) {
      this.pendingRename = { added, deleted, bin };
      return;
    }
    this.change(this.idFor(path), added, deleted, bin);
  }
  header(h) {
    const parts = h.split(US);
    const sha = parts[0] ?? "";
    const time = Number.parseInt(parts[1] ?? "0", 10) || 0;
    const name = parts[2] ?? "";
    const email = (parts[3] ?? "").toLowerCase();
    const subject = parts.slice(4).join(US);
    let authorIndex = this.authorByEmail.get(email);
    if (authorIndex === void 0) {
      authorIndex = this.authors.length;
      this.authorByEmail.set(email, authorIndex);
      this.authors.push({ name, email });
    } else {
      this.authors[authorIndex].name = name;
    }
    this.current = { sha, time, authorIndex, subject, changes: [] };
  }
  flush() {
    if (!this.current)
      return;
    const merged = /* @__PURE__ */ new Map();
    for (const c of this.current.changes) {
      const m = merged.get(c.fileId);
      if (m) {
        m.added += c.added;
        m.deleted += c.deleted;
      } else
        merged.set(c.fileId, { ...c });
    }
    this.current.changes = [...merged.values()];
    this.commits.push(this.current);
    this.current = null;
  }
  idFor(path) {
    let id = this.pathToId.get(path);
    if (id === void 0) {
      id = this.idToPath.length;
      this.idToPath.push(path);
      this.binary.push(false);
      this.pathToId.set(path, id);
    }
    return id;
  }
  rename(oldPath, newPath, added, deleted, bin) {
    let id = this.pathToId.get(oldPath);
    if (id === void 0)
      id = this.idFor(newPath);
    else {
      this.pathToId.delete(oldPath);
      this.pathToId.set(newPath, id);
      this.idToPath[id] = newPath;
    }
    this.change(id, added, deleted, bin);
  }
  change(fileId, added, deleted, bin) {
    if (bin)
      this.binary[fileId] = true;
    this.current?.changes.push({ fileId, added, deleted });
  }
};
function streamGit(repo, args, onData, input) {
  return new Promise((resolve3, reject) => {
    const child = spawn2("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const err = [];
    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => reject(new GitError("GIT_FAILED", `could not run git: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0)
        resolve3();
      else
        reject(new GitError("GIT_FAILED", Buffer.concat(err).toString("utf8").trim() || `git exited with ${code}`));
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
async function listHead(repo) {
  const out = (await git(repo, ["ls-tree", "-r", "-l", "-z", "HEAD"])).toString("utf8");
  const map = /* @__PURE__ */ new Map();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("	");
    if (tab === -1)
      continue;
    const [, type, sha, size] = entry.slice(0, tab).split(/ +/);
    if (type !== "blob" || !sha)
      continue;
    map.set(entry.slice(tab + 1), { sha, size: Number.parseInt(size ?? "0", 10) || 0 });
  }
  return map;
}
async function countBlobs(repo, shas) {
  const result = /* @__PURE__ */ new Map();
  if (shas.length === 0)
    return result;
  let header = [];
  let remaining = -1;
  let sha = "";
  let seen = 0;
  let lines = 0;
  let binary = false;
  const finish = () => {
    result.set(sha, { lines, binary });
    remaining = -2;
  };
  const onData = (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (remaining === -2) {
        i++;
        remaining = -1;
        continue;
      }
      if (remaining === -1) {
        const nl = chunk.indexOf(10, i);
        if (nl === -1) {
          header.push(chunk.subarray(i));
          return;
        }
        header.push(chunk.subarray(i, nl));
        const line = Buffer.concat(header).toString("utf8");
        header = [];
        i = nl + 1;
        const [s, type, size] = line.split(" ");
        if (type === "missing" || size === void 0)
          continue;
        sha = s ?? "";
        remaining = Number.parseInt(size, 10) || 0;
        seen = 0;
        lines = 0;
        binary = false;
        if (remaining === 0)
          finish();
        continue;
      }
      const take = Math.min(remaining, chunk.length - i);
      const part = chunk.subarray(i, i + take);
      if (seen < BINARY_SNIFF && !binary) {
        const sniff = part.subarray(0, BINARY_SNIFF - seen);
        if (sniff.indexOf(0) !== -1)
          binary = true;
      }
      for (let p = part.indexOf(10); p !== -1; p = part.indexOf(10, p + 1))
        lines++;
      seen += take;
      remaining -= take;
      i += take;
      if (remaining === 0)
        finish();
    }
  };
  await streamGit(repo, ["cat-file", "--batch"], onData, `${shas.join("\n")}
`);
  return result;
}
async function ingest(repo, opts = {}) {
  const { root, head } = await resolveRepo(repo);
  const args = ["log", "--reverse", "--no-merges", "-M", "--numstat", "-z", "--no-color", "--no-ext-diff"];
  if (opts.maxCommits !== void 0)
    args.push(`--max-count=${opts.maxCommits}`);
  if (opts.since !== void 0)
    args.push(`--since=${opts.since}`);
  args.push(`--format=${RS}%H${US}%at${US}%an${US}%ae${US}%s`, "HEAD");
  const parser = new LogParser();
  await streamGit(root, args, (c) => parser.push(c));
  const commits = parser.end();
  const headFiles = await listHead(root);
  for (const path of [...headFiles.keys()].sort()) {
    if (!parser.pathToId.has(path)) {
      parser.pathToId.set(path, parser.idToPath.length);
      parser.idToPath.push(path);
      parser.binary.push(false);
    }
  }
  const small = /* @__PURE__ */ new Set();
  for (const blob of headFiles.values())
    if (blob.size <= MAX_COUNTED_BLOB)
      small.add(blob.sha);
  const stats = await countBlobs(root, [...small].sort());
  const files = parser.idToPath.map((path, id) => {
    const blob = parser.pathToId.get(path) === id ? headFiles.get(path) : void 0;
    if (!blob)
      return { path, binary: parser.binary[id] ?? false, loc: 0, deleted: true };
    const s = stats.get(blob.sha);
    const binary = (parser.binary[id] ?? false) || (s?.binary ?? false);
    return { path, binary, loc: binary ? 0 : s ? s.lines : null, deleted: false };
  });
  return { repoName: basename(root), head, commits, files, authors: parser.authors };
}

// ../core/dist/metrics.js
var MASS_COMMIT_FILES = 50;
var MIN_BUCKETS = 8;
var MAX_BUCKETS = 128;
var HEAT_DECAY = 0.85;
var WEEK = 7 * 24 * 3600;
var U16 = 65535;
var FIX_PREFIX = /^(fix|hotfix|bugfix)(\(.+\))?!?:/i;
var FIX_WORD = /\b(fix|fixes|fixed|bug|bugs|hotfix|regression|crash)\b/i;
function isFixCommit(subject) {
  return FIX_PREFIX.test(subject) || FIX_WORD.test(subject);
}
function isMassCommit(commit) {
  return commit.changes.length > MASS_COMMIT_FILES;
}
function coChangeGraph(fileCount, commits) {
  const adj = Array.from({ length: fileCount }, () => /* @__PURE__ */ new Map());
  for (const c of commits) {
    const n = c.changes.length;
    if (n < 2 || n > MASS_COMMIT_FILES)
      continue;
    const w = 1 / (n - 1);
    const ids = c.changes.map((ch) => ch.fileId).sort((a, b) => a - b);
    for (let i = 0; i < n; i++) {
      const a = ids[i];
      const ma = adj[a];
      for (let j = i + 1; j < n; j++) {
        const b = ids[j];
        ma.set(b, (ma.get(b) ?? 0) + w);
        const mb = adj[b];
        mb.set(a, (mb.get(a) ?? 0) + w);
      }
    }
  }
  return adj;
}
function pageRank(adj, damping = 0.85, iterations = 30) {
  const n = adj.length;
  let rank = new Float64Array(n).fill(n ? 1 / n : 0);
  if (n === 0)
    return rank;
  const outWeight = new Float64Array(n);
  const edges = adj.map((m, i) => {
    const keys = [...m.keys()].sort((a, b) => a - b);
    const to = Int32Array.from(keys);
    const w = Float64Array.from(keys.map((k) => m.get(k)));
    let sum = 0;
    for (const x of w)
      sum += x;
    outWeight[i] = sum;
    return { to, w };
  });
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++)
      if (outWeight[i] === 0)
        dangling += rank[i];
    const base = (1 - damping) / n + damping * dangling / n;
    const next = new Float64Array(n).fill(base);
    for (let i = 0; i < n; i++) {
      const ow = outWeight[i];
      if (ow === 0)
        continue;
      const share = damping * rank[i] / ow;
      const { to, w } = edges[i];
      for (let k = 0; k < to.length; k++)
        next[to[k]] += share * w[k];
    }
    rank = next;
  }
  return rank;
}
function normalise(values) {
  const out = new Float64Array(values.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min)
      min = v;
    if (v > max)
      max = v;
  }
  const span = max - min;
  if (!(span > 0))
    return out;
  for (let i = 0; i < values.length; i++)
    out[i] = (values[i] - min) / span;
  return out;
}
function makeBuckets(commits) {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const c of commits) {
    if (c.time < first)
      first = c.time;
    if (c.time > last)
      last = c.time;
  }
  if (!Number.isFinite(first))
    first = last = 0;
  const span = last - first;
  const weeks = Math.ceil(span / WEEK);
  const count = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, weeks));
  const width = span > 0 ? span / count : 1;
  const start = new Uint32Array(count);
  for (let t = 0; t < count; t++)
    start[t] = first + Math.floor(t * width);
  return { count, first, width, start };
}
function bucketOf(b, time) {
  const t = Math.floor((time - b.first) / b.width);
  return t < 0 ? 0 : t >= b.count ? b.count - 1 : t;
}
function percentile(sorted, p) {
  if (sorted.length === 0)
    return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
function buildModel(ing) {
  const F = ing.files.length;
  const buckets = makeBuckets(ing.commits);
  const B = buckets.count;
  const churn = new Uint32Array(F);
  const fixes = new Uint32Array(F);
  const authorSets = Array.from({ length: F }, () => /* @__PURE__ */ new Set());
  const delta = new Float64Array(F * B);
  const fixesIn = new Uint32Array(F * B);
  const churnByBucket = new Uint32Array(F * B);
  const netTotal = new Float64Array(F);
  const series = {
    commits: new Uint32Array(B),
    fixCommits: new Uint32Array(B),
    added: new Float64Array(B),
    deleted: new Float64Array(B)
  };
  for (const c of ing.commits) {
    const t = bucketOf(buckets, c.time);
    const mass = isMassCommit(c);
    const fix = !mass && isFixCommit(c.subject);
    series.commits[t] = series.commits[t] + 1;
    if (fix)
      series.fixCommits[t] = series.fixCommits[t] + 1;
    for (const ch of c.changes) {
      const id = ch.fileId;
      const k = id * B + t;
      delta[k] = delta[k] + ch.added - ch.deleted;
      netTotal[id] = netTotal[id] + ch.added - ch.deleted;
      series.added[t] = series.added[t] + ch.added;
      series.deleted[t] = series.deleted[t] + ch.deleted;
      authorSets[id].add(c.authorIndex);
      if (mass)
        continue;
      churn[id] = churn[id] + 1;
      churnByBucket[k] = churnByBucket[k] + 1;
      if (fix) {
        fixes[id] = fixes[id] + 1;
        fixesIn[k] = fixesIn[k] + 1;
      }
    }
  }
  const centrality = normalise(pageRank(coChangeGraph(F, ing.commits)));
  const history = new Uint16Array(F * B * 2);
  const rawHeat = new Float64Array(F * B);
  const files = new Array(F);
  for (let id = 0; id < F; id++) {
    const f = ing.files[id];
    const net = Math.max(0, netTotal[id]);
    const loc = f.deleted ? 0 : f.loc ?? net;
    let running = f.deleted ? 0 : Math.max(0, loc - netTotal[id]);
    let locMax = running;
    let heat = 0;
    for (let t = 0; t < B; t++) {
      const k = id * B + t;
      running = Math.max(0, running + delta[k]);
      if (running > locMax)
        locMax = running;
      heat = heat * HEAT_DECAY + fixesIn[k];
      rawHeat[k] = heat;
      history[k * 2] = Math.min(U16, Math.round(running));
    }
    files[id] = {
      loc,
      locMax: Math.round(Math.max(locMax, loc)),
      churn: churn[id],
      fixes: fixes[id],
      authors: authorSets[id].size,
      centrality: centrality[id],
      deleted: f.deleted,
      binary: f.binary
    };
  }
  const positive = Float64Array.from(rawHeat.filter((h) => h > 0)).sort();
  const p95 = percentile(positive, 0.95);
  if (p95 > 0) {
    for (let k = 0; k < rawHeat.length; k++) {
      const v = Math.min(1, rawHeat[k] / p95);
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
    commitCount: ing.commits.length
  };
}

// ../core/dist/demo.js
var DAY = 86400;
var WEEK2 = 7 * DAY;
var START = Date.UTC(2019, 0, 7) / 1e3;
var WEEKS = 6 * 52;

// ../core/dist/index.js
var PACKAGE_VERSION = "0.1.0";

// src/analyze.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// src/args.ts
var UsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
function parseArgs(argv, specs) {
  const positionals = [];
  const options = /* @__PURE__ */ new Map();
  const byLong = new Map(specs.map((s) => [s.name, s]));
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short, s]));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let spec;
    let inline;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) inline = arg.slice(eq + 1);
      spec = byLong.get(name);
      if (!spec) throw new UsageError(`unknown option ${arg}`);
    } else if (arg.startsWith("-") && arg.length > 1) {
      spec = byShort.get(arg.slice(1));
      if (!spec) throw new UsageError(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
      continue;
    }
    if (spec.flag) {
      if (inline !== void 0) throw new UsageError(`--${spec.name} does not take a value`);
      options.set(spec.name, true);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === void 0 || inline === void 0 && value.startsWith("-") && value.length > 1) {
      throw new UsageError(`--${spec.name} needs a value`);
    }
    options.set(spec.name, value);
  }
  return { positionals, options };
}
function intOption(p, name, min = 1) {
  const v = p.options.get(name);
  if (v === void 0) return void 0;
  if (v === true || !/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  const n = Number.parseInt(v, 10);
  if (n < min || !Number.isSafeInteger(n)) throw new UsageError(`--${name} must be at least ${min}`);
  return n;
}
function stringOption(p, name) {
  const v = p.options.get(name);
  return v === void 0 || v === true ? void 0 : v;
}

// src/format-text.ts
var fmtInt = (n) => Math.round(n).toLocaleString("en-US");
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
var fmtDate = (unix) => new Date(unix * 1e3).toISOString().slice(0, 10);
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}\u2026${s.slice(s.length - (keep - head))}`;
}

// src/analyze.ts
var ANALYZE_USAGE = "git-cinematic analyze [repo=.] [-o .cinematic/city.bin] [--since 2023-01-01] [--max-commits 50000] [--max-files 20000]";
async function analyzeCommand(argv, io) {
  let repoArg;
  let outArg;
  let since;
  let maxCommits;
  let maxFiles;
  try {
    const p = parseArgs(argv, [
      { name: "output", short: "o" },
      { name: "since" },
      { name: "max-commits" },
      { name: "max-files" }
    ]);
    if (p.positionals.length > 1) throw new UsageError("analyze takes at most one repository path");
    repoArg = p.positionals[0] ?? ".";
    outArg = stringOption(p, "output");
    since = stringOption(p, "since");
    if (since !== void 0 && Number.isNaN(Date.parse(since))) throw new UsageError("--since must be a date");
    maxCommits = intOption(p, "max-commits");
    maxFiles = intOption(p, "max-files");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}
usage: ${ANALYZE_USAGE}
`);
      return 2;
    }
    throw e;
  }
  const started = performance.now();
  try {
    const { root } = await resolveRepo(resolve(io.cwd, repoArg));
    const outPath = outArg ? resolve(io.cwd, outArg) : resolve(root, ".cinematic/city.bin");
    const ing = await ingest(root, { since, maxCommits });
    const model = buildModel(ing);
    const city = buildCity(model, { maxFiles, generatedAt: await headTime(root) });
    const bytes = packCity(city);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
    const seconds = (performance.now() - started) / 1e3;
    const deleted = city.files.filter((f) => f.flags & FILE_DELETED).length;
    const lines = [
      `git-cinematic \xB7 ${city.repoName}`,
      "",
      `  commits  ${fmtInt(model.commitCount)}    files  ${fmtInt(city.files.length)}${deleted ? ` (${fmtInt(deleted)} deleted)` : ""}    authors  ${fmtInt(city.authors.length)}    eras  ${city.eras.length}`
    ];
    if (city.bucketStart.length) {
      lines.push(
        `  span     ${fmtDate(city.bucketStart[0])} \u2192 ${fmtDate(city.generatedAt)} in ${city.bucketStart.length} buckets`
      );
    }
    if (city.flags & 1)
      lines.push(`  note     smaller files folded into "(other)" buildings (--max-files ${maxFiles})`);
    lines.push("", "  eras");
    for (const era of city.eras) {
      const from = fmtDate(city.bucketStart[era.startBucket]);
      lines.push(`    ${from}  ${ERA_KIND_NAMES[era.kind].padEnd(12)}  ${era.title.split(" \xB7 ")[1] ?? ""}`);
    }
    lines.push("", "  top hotspots (churn \xD7 size)");
    const top = hotspots(city.files).filter((h) => h.score > 0).slice(0, 5);
    if (top.length === 0) lines.push("    none yet");
    top.forEach((h, i) => {
      const f = city.files[h.index];
      if (!f) return;
      lines.push(
        `    ${i + 1}. ${truncateMiddle(f.path, 52).padEnd(52)}  ${String(f.churn).padStart(5)} ${f.churn === 1 ? "commit " : "commits"}  ${fmtInt(f.loc).padStart(7)} lines`
      );
    });
    const rel = relative(io.cwd, outPath);
    const shown = rel && !rel.startsWith("..") ? rel : outPath;
    lines.push("", `  wrote ${shown} (${fmtBytes(bytes.length)}) in ${seconds.toFixed(1)} s`, "");
    io.out(lines.join("\n"));
    return 0;
  } catch (e) {
    if (e instanceof GitError && (e.code === "NOT_A_REPO" || e.code === "NO_COMMITS" || e.code === "GIT_MISSING")) {
      io.err(`error: ${e.message}
`);
      return 1;
    }
    throw e;
  }
}

// src/view.ts
import { spawn as spawn3 } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve as resolve2, sep } from "node:path";
import { fileURLToPath } from "node:url";
var VIEW_USAGE = "git-cinematic view    [city=.cinematic/city.bin] [--port 4173] [--no-open]";
var CITY_ROUTE = "/local/city.bin";
var DEFAULT_CITY = ".cinematic/city.bin";
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8"
};
function bundledViewerDir() {
  return fileURLToPath(new URL("./viewer/", import.meta.url));
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function serveFile(req, res, file, cache) {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const size = statSync(file).size;
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(size),
    "cache-control": cache,
    "x-content-type-options": "nosniff"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
function createViewServer(opts) {
  const root = resolve2(opts.viewerDir);
  return createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      send(res, 400, "bad request");
      return;
    }
    if (pathname === CITY_ROUTE) {
      if (!existsSync(opts.cityPath)) {
        send(res, 404, "city file not found");
        return;
      }
      serveFile(req, res, opts.cityPath, "no-store");
      return;
    }
    if (pathname === "/healthz") {
      send(res, 200, "ok");
      return;
    }
    const file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      send(res, 403, "forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isFile()) {
      serveFile(req, res, file, pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return;
    }
    if (!extname(pathname) || pathname.endsWith(".html")) {
      serveFile(req, res, join(root, "index.html"), "no-cache");
      return;
    }
    send(res, 404, "not found");
  });
}
async function startViewServer(opts) {
  const attempts = opts.portAttempts ?? 10;
  for (let i = 0; i < attempts; i++) {
    const server = createViewServer(opts);
    const port = opts.port === 0 ? 0 : opts.port + i;
    try {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolveListen());
      });
      const addr = server.address();
      return { server, url: `http://127.0.0.1:${addr.port}/` };
    } catch (e) {
      server.close();
      if (e.code !== "EADDRINUSE" || i === attempts - 1) throw e;
    }
  }
  throw new Error("no free port");
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const child = spawn3(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
async function viewCommand(argv, io, hooks = {}) {
  let cityArg;
  let port;
  let open;
  try {
    const p = parseArgs(argv, [{ name: "port" }, { name: "no-open", flag: true }]);
    if (p.positionals.length > 1) throw new UsageError("view takes at most one city file");
    cityArg = p.positionals[0] ?? "";
    port = intOption(p, "port", 0) ?? 4173;
    if (port > 65535) throw new UsageError("--port must be at most 65535");
    open = !p.options.has("no-open");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}
usage: ${VIEW_USAGE}
`);
      return 2;
    }
    throw e;
  }
  let cityPath = resolve2(io.cwd, cityArg || DEFAULT_CITY);
  if (!cityArg && !existsSync(cityPath)) {
    try {
      const { root } = await resolveRepo(io.cwd);
      cityPath = resolve2(root, DEFAULT_CITY);
    } catch {
    }
  }
  if (!existsSync(cityPath) || !statSync(cityPath).isFile()) {
    io.err(`error: no city file at ${cityPath}
run "git-cinematic analyze" first to create one
`);
    return 1;
  }
  const viewerDir = process.env.GIT_CINEMATIC_VIEWER ?? bundledViewerDir();
  if (!existsSync(join(viewerDir, "index.html"))) {
    io.err(`error: the viewer is missing from this installation (${viewerDir})
`);
    return 1;
  }
  const { server, url } = await startViewServer({ cityPath, viewerDir, port });
  const pageUrl = `${url}?src=${CITY_ROUTE}`;
  io.out(`git-cinematic: serving ${cityPath}
  ${pageUrl}
  press Ctrl+C to stop
`);
  if (open) openBrowser(pageUrl);
  hooks.onListening?.(pageUrl, server);
  return new Promise((resolveExit) => {
    const stop = () => {
      server.close(() => resolveExit(0));
      server.closeAllConnections?.();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.once("close", () => resolveExit(0));
  });
}

// src/cli.ts
var HELP = `git-cinematic ${PACKAGE_VERSION}
Fly through your git history as a living 3D city.

usage:
  ${ANALYZE_USAGE}
  ${VIEW_USAGE}
  git-cinematic --version | --help

Nothing is uploaded: the city file holds paths, counts and scores, never file contents.
`;
async function main(argv, io) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "analyze":
      return analyzeCommand(rest, io);
    case "view":
      return viewCommand(rest, io);
    case "--version":
    case "-v":
      io.out(`${PACKAGE_VERSION}
`);
      return 0;
    case "--help":
    case "-h":
    case "help":
    case void 0:
      io.out(HELP);
      return 0;
    default:
      io.err(`error: unknown command ${cmd}

${HELP}`);
      return 2;
  }
}

// src/main.ts
main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd()
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}
`);
    process.exitCode = 1;
  }
);
