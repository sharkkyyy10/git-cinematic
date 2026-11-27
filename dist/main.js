#!/usr/bin/env node

// ../core/dist/format.js
var MAGIC = "GCTY";
var FORMAT_VERSION = 1;
var HEADER_BYTES = 40;
var FILE_RECORD_BYTES = 40;
var DIR_RECORD_BYTES = 20;
var ERA_RECORD_BYTES = 12;
var MAX_DECODE_FILES = 2e5;
var MAX_DECODE_BUCKETS = 1024;
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
function decodeCity(bytes) {
  if (bytes.byteLength > MAX_CITY_BYTES)
    throw new CityFormatError("city file is larger than 64 MB");
  if (bytes.byteLength < HEADER_BYTES)
    throw new CityFormatError("city file is truncated (no header)");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC)
    throw new CityFormatError("not a city file (bad magic)");
  const version = v.getUint16(4, true);
  if (version !== FORMAT_VERSION)
    throw new CityFormatError(`unsupported city format version ${version}`);
  const flags = v.getUint16(6, true);
  const F = v.getUint32(8, true);
  const D = v.getUint32(12, true);
  const B = v.getUint32(16, true);
  const A = v.getUint32(20, true);
  const E = v.getUint32(24, true);
  const S = v.getUint32(28, true);
  const generatedAt = v.getUint32(32, true);
  if (F > MAX_DECODE_FILES)
    throw new CityFormatError(`too many files (${F})`);
  if (B > MAX_DECODE_BUCKETS)
    throw new CityFormatError(`too many buckets (${B})`);
  if (D > MAX_DECODE_FILES || A > MAX_DECODE_FILES || E > MAX_DECODE_BUCKETS || S > MAX_CITY_BYTES) {
    throw new CityFormatError("header counts are out of range");
  }
  const L = layout(F, D, B, E, S);
  if (L.total !== bytes.byteLength) {
    throw new CityFormatError(L.total > bytes.byteLength ? "city file is truncated" : "city file has trailing bytes (size mismatch)");
  }
  const table = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(L.strings, L.strings + S));
  const strings = table.split("\0");
  const expected = 1 + F + D + A + E;
  if (strings.length !== expected) {
    throw new CityFormatError(`string table has ${strings.length} entries, expected ${expected}`);
  }
  let si = 0;
  const next = () => strings[si++];
  const repoName = next();
  const bucketStart = new Uint32Array(B);
  for (let t = 0; t < B; t++)
    bucketStart[t] = v.getUint32(L.bucketStart + 4 * t, true);
  const files = new Array(F);
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
      flags: v.getUint16(o + 38, true)
    };
  }
  const dirs = new Array(D);
  for (let i = 0; i < D; i++) {
    const o = L.dirs + i * DIR_RECORD_BYTES;
    dirs[i] = {
      path: next(),
      x: v.getFloat32(o, true),
      z: v.getFloat32(o + 4, true),
      w: v.getFloat32(o + 8, true),
      d: v.getFloat32(o + 12, true),
      depth: v.getUint16(o + 16, true)
    };
  }
  const authors = new Array(A);
  for (let i = 0; i < A; i++)
    authors[i] = next();
  const eras = new Array(E);
  for (let i = 0; i < E; i++) {
    const o = L.eras + i * ERA_RECORD_BYTES;
    const startBucket = v.getUint32(o, true);
    const endBucket = v.getUint32(o + 4, true);
    const kind = v.getUint32(o + 8, true);
    if (kind > 3)
      throw new CityFormatError(`unknown era kind ${kind}`);
    if (startBucket > endBucket || endBucket >= Math.max(B, 1))
      throw new CityFormatError("era is out of range");
    eras[i] = { title: next(), startBucket, endBucket, kind };
  }
  const history = new Uint16Array(F * B * 2);
  for (let k = 0; k < history.length; k++)
    history[k] = v.getUint16(L.history + 2 * k, true);
  return { flags, generatedAt, repoName, bucketStart, files, dirs, authors, eras, history };
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
var LOCK_FILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "flake.lock",
  "package.resolved",
  "podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "packages.lock.json",
  "gradle.lockfile"
]);
var CHANGELOG = /^(changelog|changes|history|news|releases?)(\.(md|markdown|rst|txt|adoc))?$/i;
var GENERATED = /(\.min\.(js|css|mjs)|\.map|\.snap|\.pb\.go|_pb2(_grpc)?\.py|\.pb\.(cc|h)|\.generated\.[a-z]+|\.g\.dart|\.freezed\.dart|\.designer\.cs|\.lock)$/i;
var VENDORED = /(^|\/)(node_modules|vendor|third[_-]party|bower_components|__snapshots__|\.yarn|dist|coverage)\//i;
function noiseKind(path) {
  const base = (path.slice(path.lastIndexOf("/") + 1) || path).toLowerCase();
  if (LOCK_FILES.has(base))
    return "lock file";
  if (CHANGELOG.test(base))
    return "changelog";
  if (VENDORED.test(path))
    return "vendored";
  if (GENERATED.test(base))
    return "generated";
  return null;
}
function hotspots(files) {
  const counted = files.map((f) => !(f.flags & FILE_DELETED) && f.churn > 0 && f.loc > 0 && noiseKind(f.path) === null);
  const idx = files.map((_, i) => i).filter((i) => counted[i]);
  const churn = rankPercentile(idx.map((i) => files[i].churn));
  const loc = rankPercentile(idx.map((i) => files[i].loc));
  const score = new Float64Array(files.length);
  idx.forEach((i, k) => {
    score[i] = churn[k] * loc[k];
  });
  return files.map((_, index) => ({ index, score: score[index] })).sort((a, b) => b.score - a.score || a.index - b.index);
}

// ../core/dist/insights.js
var LENSES = [
  {
    id: "risk",
    label: "Risk",
    question: "Where will the next problem come from?",
    low: "small or quiet",
    high: "large and always changing",
    explain: "Hotspot score: how large a file is times how often it changes, both as rank percentiles. Most defects and slow reviews concentrate in a few such files."
  },
  {
    id: "bugs",
    label: "Bugs",
    question: "Which files keep needing fixes?",
    low: "no fixes",
    high: "many fixes",
    explain: "Fix commits touching the file (messages like fix, bug, hotfix, revert), weighted by how large a share of its changes were fixes."
  },
  {
    id: "silos",
    label: "Silos",
    question: "Which busy files depend on one person?",
    low: "shared knowledge",
    high: "one author, lots of change",
    explain: "Files with a single author ranked by how often they change; two-author files count a little. If that person leaves, nobody else knows this code."
  },
  {
    id: "coupling",
    label: "Coupling",
    question: "Which files drag others along when they change?",
    low: "independent",
    high: "changes with everything",
    explain: "Co-change centrality (PageRank over files committed together). Edits here ripple into many other files and need wider review."
  },
  {
    id: "age",
    label: "Age",
    question: "What has nobody touched in a long time?",
    low: "changed recently",
    high: "untouched for longest",
    explain: "Time since the file last visibly changed, relative to the whole history. Old, large files are either rock-solid or forgotten."
  }
];
var HOT_NOW = 0.25;
var HOTSPOT_MIN = 0.8;
var BIG_FILE_LINES = 1e3;
var clamp01 = (v) => Math.min(1, Math.max(0, v));
function isCounted(f) {
  return isAlive(f) && noiseKind(f.path) === null;
}
function isAlive(f) {
  return (f.flags & FILE_DELETED) === 0 && f.loc > 0;
}
function fileSignals(city) {
  const F = city.files.length;
  const B = city.bucketStart.length;
  const h = city.history;
  const lastChange = new Int32Array(F).fill(-1);
  const heatNow = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    let prevLoc = 0;
    let prevHeat = 0;
    for (let b = 0; b < B; b++) {
      const loc = h[(i * B + b) * 2] ?? 0;
      const heat = h[(i * B + b) * 2 + 1] ?? 0;
      if (loc !== prevLoc || heat > prevHeat)
        lastChange[i] = b;
      prevLoc = loc;
      prevHeat = heat;
    }
    if (B > 0)
      heatNow[i] = (h[(i * B + B - 1) * 2 + 1] ?? 0) / 65535;
  }
  const risk = new Float32Array(F);
  for (const s of hotspots(city.files))
    risk[s.index] = s.score;
  const fixed = city.files.map((f) => isCounted(f) ? f.fixes : 0);
  const fixPct = rankPercentile(fixed);
  const bugs = new Float32Array(F);
  city.files.forEach((f, i) => {
    if (!isCounted(f) || f.fixes === 0)
      return;
    const ratio = f.churn > 0 ? f.fixes / f.churn : 0;
    bugs[i] = clamp01(0.6 * (fixPct[i] ?? 0) + 0.4 * clamp01(ratio * 2));
  });
  const team = city.authors.length >= 2;
  const churnPct = rankPercentile(city.files.map((f) => isCounted(f) ? f.churn : 0));
  const silos = new Float32Array(F);
  if (team) {
    city.files.forEach((f, i) => {
      if (!isCounted(f) || f.churn === 0)
        return;
      if (f.authors === 1)
        silos[i] = churnPct[i] ?? 0;
      else if (f.authors === 2)
        silos[i] = 0.4 * (churnPct[i] ?? 0);
    });
  }
  const coupling = new Float32Array(F);
  const age = new Float32Array(F);
  city.files.forEach((f, i) => {
    if (!isCounted(f))
      return;
    coupling[i] = clamp01(f.centrality);
    const last = lastChange[i] ?? -1;
    age[i] = B > 1 && last >= 0 ? (B - 1 - last) / (B - 1) : 0;
  });
  return { risk, bugs, silos, coupling, age, lastChange, heatNow };
}
var pct = (v) => `${Math.round(v * 100)}%`;
function gradeFor(score) {
  return score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "E";
}
function health(city, signals = fileSignals(city)) {
  const alive = city.files.map((f, i) => [f, i]).filter(([f]) => isCounted(f));
  const signal = city.files.filter((f) => noiseKind(f.path) === null);
  const totalChurn = signal.reduce((s, f) => s + f.churn, 0);
  const totalFixes = signal.reduce((s, f) => s + f.fixes, 0);
  const aliveLoc = alive.reduce((s, [f]) => s + f.loc, 0);
  const fixShare = totalChurn > 0 ? totalFixes / totalChurn : 0;
  const parts = [
    {
      id: "fixLoad",
      label: "Fix load",
      score: clamp01(1 - fixShare / 0.4),
      detail: `${pct(fixShare)} of file changes were bug fixes`,
      weight: 0.35
    }
  ];
  if (city.authors.length >= 2) {
    const soloLoc = alive.filter(([f]) => f.authors === 1).reduce((s, [f]) => s + f.loc, 0);
    const share = aliveLoc > 0 ? soloLoc / aliveLoc : 0;
    parts.push({
      id: "knowledge",
      label: "Knowledge spread",
      score: clamp01(1 - share),
      detail: `${pct(share)} of the code has only one author`,
      weight: 0.25
    });
  }
  const hot = alive.filter(([, i]) => (signals.heatNow[i] ?? 0) >= HOT_NOW).length;
  const hotShare = alive.length ? hot / alive.length : 0;
  parts.push({
    id: "fireNow",
    label: "Fires right now",
    score: clamp01(1 - hotShare / 0.15),
    detail: `${hot} of ${alive.length} files are hot with recent fixes`,
    weight: 0.2
  });
  const bigLoc = alive.filter(([f]) => f.loc > BIG_FILE_LINES).reduce((s, [f]) => s + f.loc, 0);
  const bigShare = aliveLoc > 0 ? bigLoc / aliveLoc : 0;
  parts.push({
    id: "fileSize",
    label: "File size",
    score: clamp01(1 - bigShare / 0.5),
    detail: `${pct(bigShare)} of the code sits in files over ${BIG_FILE_LINES.toLocaleString("en-US")} lines`,
    weight: 0.2
  });
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round(100 * parts.reduce((s, p) => s + p.score * p.weight, 0) / totalWeight);
  return { score, grade: gradeFor(score), parts };
}
var TOP = 5;
function quantile(sorted, q) {
  if (sorted.length === 0)
    return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}
function findings(city, signals = fileSignals(city)) {
  const out = [];
  const files = city.files;
  const alive = files.map((_, i) => i).filter((i) => isCounted(files[i]));
  const by = (key) => (a, b) => key(b) - key(a) || a - b;
  const f = (i) => files[i];
  const focus = (list2, share) => list2.slice(0, Math.max(TOP, Math.ceil(alive.length * share)));
  const hot = focus(alive.filter((i) => (signals.risk[i] ?? 0) >= HOTSPOT_MIN && f(i).churn >= 3).sort(by((i) => signals.risk[i] ?? 0)), 0.02);
  if (hot.length) {
    out.push({
      id: "hotspots",
      severity: (signals.risk[hot[0]] ?? 0) >= 0.9 ? "high" : "medium",
      title: `${hot.length} hotspot${hot.length === 1 ? "" : "s"}: large files that never stop changing`,
      why: "Defects, merge conflicts and slow reviews concentrate in files that are both big and busy.",
      action: "Start refactoring and testing here: split the largest, and add tests before the next change.",
      files: hot.slice(0, TOP),
      matches: hot,
      lens: "risk"
    });
  }
  const fire = alive.filter((i) => (signals.heatNow[i] ?? 0) >= HOT_NOW).sort(by((i) => signals.heatNow[i] ?? 0));
  if (fire.length) {
    out.push({
      id: "fire",
      severity: fire.length >= 5 ? "high" : "medium",
      title: `${fire.length} file${fire.length === 1 ? " is" : "s are"} on fire right now`,
      why: "These files received bug fixes recently and repeatedly. Fixes that keep coming usually mean the cause is not fixed yet.",
      action: "Look for the root cause before the next patch: a missing test, an unclear contract or a design limit.",
      files: fire.slice(0, TOP),
      matches: fire,
      lens: "bugs"
    });
  }
  const buggy = focus(alive.filter((i) => f(i).fixes >= 2).sort(by((i) => f(i).fixes * 10 + (signals.bugs[i] ?? 0))), 0.03);
  if (buggy.length) {
    out.push({
      id: "bugs",
      severity: f(buggy[0]).fixes >= 5 ? "high" : "medium",
      title: `${buggy.length} bug-prone file${buggy.length === 1 ? "" : "s"}`,
      why: "Files fixed again and again are where users feel the bugs. A file's past fix rate is one of the best predictors of its future bugs.",
      action: "Give these files an owner, stronger tests and a review checklist.",
      files: buggy.slice(0, TOP),
      matches: buggy,
      lens: "bugs"
    });
  }
  if (city.authors.length >= 2) {
    const silo = alive.filter((i) => f(i).authors === 1 && f(i).churn >= 3).sort(by((i) => f(i).churn));
    if (silo.length) {
      out.push({
        id: "silos",
        severity: silo.length >= 10 ? "high" : "medium",
        title: `${silo.length} knowledge silo${silo.length === 1 ? "" : "s"}: busy files only one person has touched`,
        why: "If that person is away or leaves, nobody else understands these files. This is the bus factor, file by file.",
        action: "Pair on the next change, or rotate reviews so a second person learns each file.",
        files: silo.slice(0, TOP),
        matches: silo,
        lens: "silos"
      });
    }
  } else if (alive.length) {
    out.push({
      id: "solo",
      severity: "low",
      title: "Single-author repository",
      why: "Every file has one author, so all knowledge lives with one person.",
      action: "Fine for a personal project. Before handing it over, document the busiest files first.",
      files: [],
      matches: []
    });
  }
  const hubs = alive.filter((i) => f(i).centrality >= 0.6).sort(by((i) => f(i).centrality));
  if (hubs.length) {
    out.push({
      id: "coupling",
      severity: hubs.length >= 8 ? "medium" : "low",
      title: `${hubs.length} change magnet${hubs.length === 1 ? "" : "s"}: files that change together with many others`,
      why: "A change here usually means changes elsewhere too, so estimates slip and reviews grow.",
      action: "Check whether these are shared configs or real tangles; extract stable interfaces where they are tangles.",
      files: hubs.slice(0, TOP),
      matches: hubs,
      lens: "coupling"
    });
  }
  const sortedLoc = alive.map((i) => f(i).loc).sort((a, b) => a - b);
  const bigLine = Math.max(300, quantile(sortedLoc, 0.75));
  const dormant = alive.filter((i) => f(i).loc >= bigLine && (signals.age[i] ?? 0) >= 0.5).sort(by((i) => f(i).loc));
  if (dormant.length) {
    out.push({
      id: "dormant",
      severity: "low",
      title: `${dormant.length} dormant giant${dormant.length === 1 ? "" : "s"}: large files untouched for a long time`,
      why: "Old, large, quiet files are either rock-solid or forgotten. Forgotten ones break the day someone has to change them.",
      action: "Confirm each still has an owner and tests, or mark it for deletion.",
      files: dormant.slice(0, TOP),
      matches: dormant,
      lens: "age"
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
var isoDate = (unix) => new Date(unix * 1e3).toISOString().slice(0, 10);
var md = (s) => s.replace(/([\\`*_[\]|<>])/g, "\\$1");
var int = (n) => Math.round(n).toLocaleString("en-US");
function renderReport(city, opts = {}) {
  const signals = fileSignals(city);
  const hp = health(city, signals);
  const found = findings(city, signals);
  const alive = city.files.filter(isAlive);
  const deleted = city.files.filter((f) => f.flags & FILE_DELETED).length;
  const binary = alive.filter((f) => f.flags & FILE_BINARY).length;
  const B = city.bucketStart.length;
  const from = B ? isoDate(city.bucketStart[0]) : isoDate(city.generatedAt);
  const to = isoDate(city.generatedAt);
  const L = [];
  L.push(`# ${md(city.repoName)}: codebase report`, "");
  L.push(`Generated by Git-Cinematic from the history between ${from} and ${to}.`, "");
  L.push(`## Health: ${hp.score}/100 (grade ${hp.grade})`, "");
  L.push("| Signal | Score | What it measures |", "|---|---:|---|");
  for (const p of hp.parts)
    L.push(`| ${p.label} | ${Math.round(p.score * 100)} | ${md(p.detail)} |`);
  L.push("", "The score is a heuristic. Use it to compare this repository with itself over time, not with other teams.", "");
  if (opts.since)
    L.push(opts.since.trimEnd(), "");
  L.push("## At a glance", "");
  L.push(`- **${int(alive.length)}** files today, **${int(alive.reduce((s, f) => s + f.loc, 0))}** lines`);
  if (deleted)
    L.push(`- **${int(deleted)}** files that existed once and were deleted`);
  const noise = alive.filter((f) => noiseKind(f.path) !== null).length;
  if (noise)
    L.push(`- **${int(noise)}** lock files, changelogs, generated or vendored files (shown, but not analysed)`);
  if (binary)
    L.push(`- **${int(binary)}** binary files (shown, but not counted in lines)`);
  L.push(`- **${int(city.authors.length)}** author${city.authors.length === 1 ? "" : "s"}`);
  L.push(`- **${city.eras.length}** era${city.eras.length === 1 ? "" : "s"} in the history`, "");
  if (city.eras.length) {
    L.push("## The story so far", "", "| From | Era | Where most of the work went |", "|---|---|---|");
    for (const e of city.eras) {
      const start = isoDate(city.bucketStart[e.startBucket] ?? city.generatedAt);
      L.push(`| ${start} | ${ERA_KIND_NAMES[e.kind]} | ${md(e.title.split(" \xB7 ")[1] ?? "")} |`);
    }
    L.push("");
  }
  L.push("## Findings", "");
  if (found.length === 0)
    L.push("Nothing stands out yet. Come back when there is more history.", "");
  for (const x of found) {
    L.push(`### ${x.severity === "high" ? "\u{1F534}" : x.severity === "medium" ? "\u{1F7E0}" : "\u{1F535}"} ${md(x.title)}`, "");
    L.push(`**Why it matters:** ${x.why}`, "", `**What to do:** ${x.action}`, "");
    if (x.files.length) {
      L.push("| File | Lines | Commits | Fixes | Authors |", "|---|---:|---:|---:|---:|");
      for (const i of x.files) {
        const f = city.files[i];
        if (f)
          L.push(`| \`${f.path.replace(/`/g, "'")}\` | ${int(f.loc)} | ${int(f.churn)} | ${int(f.fixes)} | ${int(f.authors)} |`);
      }
      L.push("");
    }
  }
  L.push("## How to read this", "");
  for (const l of LENSES)
    L.push(`- **${l.label}:** ${l.explain}`);
  L.push("", "Commits that touch more than 50 files (reformats, vendor drops, bulk renames) are left out of churn, fixes and coupling.", "The analysis ran locally. It reads file paths, line counts, author display names and commit subjects; no source code or messages are stored.", "");
  return L.join("\n");
}

// ../core/dist/badge.js
var COLORS = {
  A: "#2ea44f",
  B: "#7cb82f",
  C: "#dfb317",
  D: "#fe7d37",
  E: "#e05d44"
};
function textWidth(s) {
  let w = 0;
  for (const ch of s)
    w += /[ijlI.,:;|!' ]/.test(ch) ? 3.6 : /[mwMW]/.test(ch) ? 10 : /[A-Z0-9]/.test(ch) ? 7.6 : 6.6;
  return Math.ceil(w);
}
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function renderBadge(score, label = "code health") {
  const grade = gradeFor(score);
  const value = `${score} ${grade}`;
  const lw = textWidth(label) + 12;
  const vw = textWidth(value) + 12;
  const w = lw + vw;
  const title = esc(`${label}: ${score}/100 (grade ${grade})`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">
<title>${title}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${COLORS[grade]}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text><text x="${lw + vw / 2}" y="14">${value}</text>
</g>
</svg>
`;
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

// ../core/dist/compare.js
function hotspotPaths(city, found) {
  const h = found.find((f) => f.id === "hotspots");
  return (h?.matches ?? []).map((i) => city.files[i]?.path ?? "").filter(Boolean);
}
function compareCities(base, head) {
  const sb = fileSignals(base);
  const sh = fileSignals(head);
  const before = health(base, sb);
  const after = health(head, sh);
  const hb = new Set(hotspotPaths(base, findings(base, sb)));
  const hh = hotspotPaths(head, findings(head, sh));
  const hhSet = new Set(hh);
  const fireBefore = new Set(base.files.filter((f, i) => isCounted(f) && (sb.heatNow[i] ?? 0) >= HOT_NOW).map((f) => f.path));
  const newFires = head.files.map((f, i) => [f, sh.heatNow[i] ?? 0]).filter(([f, heat]) => isCounted(f) && heat >= HOT_NOW && !fireBefore.has(f.path)).sort((a, b) => b[1] - a[1] || (a[0].path < b[0].path ? -1 : 1)).map(([f]) => f.path);
  const locBefore = new Map(base.files.filter(isCounted).map((f) => [f.path, f.loc]));
  const countedNow = head.files.filter(isCounted);
  const grew = countedNow.map((f) => ({ path: f.path, before: locBefore.get(f.path) ?? 0, after: f.loc })).filter((d) => d.after > d.before).sort((a, b) => b.after - b.before - (a.after - a.before) || (a.path < b.path ? -1 : 1)).slice(0, 5);
  const nowPaths = new Set(countedNow.map((f) => f.path));
  return {
    before,
    after,
    delta: after.score - before.score,
    newHotspots: hh.filter((p) => !hb.has(p)),
    resolvedHotspots: [...hb].filter((p) => !hhSet.has(p)).sort(),
    newFires,
    grew,
    added: countedNow.filter((f) => !locBefore.has(f.path)).length,
    removed: [...locBefore.keys()].filter((p) => !nowPaths.has(p)).length
  };
}
var code = (p) => `\`${p.replace(/`/g, "'")}\``;
var list = (paths, max = 10) => {
  const lines = paths.slice(0, max).map((p) => `- ${code(p)}`);
  if (paths.length > max)
    lines.push(`- \u2026and ${paths.length - max} more`);
  return lines;
};
function renderComparison(c) {
  const arrow = c.delta > 0 ? "\u25B2" : c.delta < 0 ? "\u25BC" : "\u25AC";
  const L = [
    "## Since the baseline",
    "",
    `**Health ${c.before.score} \u2192 ${c.after.score}** (${arrow} ${c.delta > 0 ? "+" : ""}${c.delta}, grade ${c.before.grade} \u2192 ${c.after.grade})`,
    "",
    "| Signal | Before | Now |",
    "|---|---:|---:|"
  ];
  for (const p of c.after.parts) {
    const b = c.before.parts.find((x) => x.id === p.id);
    L.push(`| ${p.label} | ${b ? Math.round(b.score * 100) : "\u2014"} | ${Math.round(p.score * 100)} |`);
  }
  L.push("", `${c.added} files added and ${c.removed} removed.`, "");
  if (c.newHotspots.length)
    L.push(`### New hotspots (${c.newHotspots.length})`, "", ...list(c.newHotspots), "");
  if (c.resolvedHotspots.length)
    L.push(`### Hotspots resolved (${c.resolvedHotspots.length})`, "", ...list(c.resolvedHotspots), "");
  if (c.newFires.length)
    L.push(`### Newly on fire (${c.newFires.length})`, "", ...list(c.newFires), "");
  if (c.grew.length) {
    L.push("### Grew the most", "", "| File | Lines before | Lines now |", "|---|---:|---:|");
    for (const g of c.grew)
      L.push(`| ${code(g.path)} | ${g.before.toLocaleString("en-US")} | ${g.after.toLocaleString("en-US")} |`);
    L.push("");
  }
  return L.join("\n");
}

// ../core/dist/git.js
import { spawn } from "node:child_process";
var GitError = class extends Error {
  code;
  constructor(code2, message) {
    super(message);
    this.code = code2;
    this.name = "GitError";
  }
};
function git(repo, args, input) {
  return new Promise((resolve6, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      reject(new GitError(e.code === "ENOENT" ? "GIT_MISSING" : "GIT_FAILED", `could not run git: ${e.message}`));
    });
    child.on("close", (code2) => {
      if (code2 === 0)
        resolve6(Buffer.concat(out));
      else
        reject(new GitError("GIT_FAILED", Buffer.concat(err).toString("utf8").trim() || `git exited with ${code2}`));
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
function unpackCity(bytes) {
  return decodeCity(new Uint8Array(gunzipSync(bytes)));
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
  return new Promise((resolve6, reject) => {
    const child = spawn2("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const err = [];
    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => reject(new GitError("GIT_FAILED", `could not run git: ${e.message}`)));
    child.on("close", (code2) => {
      if (code2 === 0)
        resolve6();
      else
        reject(new GitError("GIT_FAILED", Buffer.concat(err).toString("utf8").trim() || `git exited with ${code2}`));
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
    const hp = health(city);
    lines.push(`  health   ${hp.score}/100 (grade ${hp.grade})  \xB7  details: git-cinematic report`);
    lines.push("", "  eras");
    for (const era of city.eras) {
      const from = fmtDate(city.bucketStart[era.startBucket]);
      lines.push(`    ${from}  ${ERA_KIND_NAMES[era.kind].padEnd(12)}  ${era.title.split(" \xB7 ")[1] ?? ""}`);
    }
    lines.push("", "  top hotspots (churn \xD7 size)");
    const top = hotspots(city.files).filter((h) => h.score > 0 && (city.files[h.index]?.churn ?? 0) >= 3).slice(0, 5);
    if (top.length === 0) lines.push("    none yet");
    top.forEach((h, i) => {
      const f = city.files[h.index];
      if (!f) return;
      lines.push(
        `    ${i + 1}. ${truncateMiddle(f.path, 52).padEnd(52)}  ${String(f.churn).padStart(5)} ${f.churn === 1 ? "commit " : "commits"}  ${fmtInt(f.loc).padStart(7)} lines`
      );
    });
    const found = findings(city).filter((f) => f.id !== "hotspots");
    if (found.length) {
      lines.push("", "  findings");
      for (const f of found.slice(0, 4)) {
        lines.push(`    ${f.severity === "high" ? "!!" : f.severity === "medium" ? "! " : "\xB7 "} ${f.title}`);
      }
    }
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

// src/badge.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, relative as relative2, resolve as resolve3 } from "node:path";

// src/city-file.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolve2 } from "node:path";
var DEFAULT_CITY = ".cinematic/city.bin";
function readCity(arg, io) {
  const path = resolve2(io.cwd, arg);
  if (!existsSync(path)) {
    io.err(`error: no city file at ${arg}; run git-cinematic analyze first
`);
    return null;
  }
  try {
    return unpackCity(readFileSync(path));
  } catch (e) {
    io.err(`error: ${arg} is not a valid city file (${e instanceof Error ? e.message : String(e)})
`);
    return null;
  }
}

// src/badge.ts
var BADGE_USAGE = 'git-cinematic badge   [city=.cinematic/city.bin] [-o .cinematic/health.svg] [--label "code health"]';
async function badgeCommand(argv, io) {
  let cityArg;
  let outArg;
  let label;
  try {
    const p = parseArgs(argv, [{ name: "output", short: "o" }, { name: "label" }]);
    if (p.positionals.length > 1) throw new UsageError("badge takes at most one city file");
    cityArg = p.positionals[0] ?? DEFAULT_CITY;
    outArg = stringOption(p, "output") ?? ".cinematic/health.svg";
    label = stringOption(p, "label") ?? "code health";
    if (label.length === 0 || label.length > 40) throw new UsageError("--label must be 1 to 40 characters");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}
usage: ${BADGE_USAGE}
`);
      return 2;
    }
    throw e;
  }
  const city = readCity(cityArg, io);
  if (!city) return 1;
  const h = health(city);
  const outPath = resolve3(io.cwd, outArg);
  mkdirSync2(dirname2(outPath), { recursive: true });
  writeFileSync2(outPath, renderBadge(h.score, label));
  const rel = relative2(io.cwd, outPath);
  io.out(`wrote ${rel && !rel.startsWith("..") ? rel : outPath} (${h.score}/100, grade ${h.grade})
`);
  return 0;
}

// src/check.ts
import { appendFileSync } from "node:fs";
var CHECK_USAGE = "git-cinematic check   [city=.cinematic/city.bin] [--min-health 60] [--baseline old.bin] [--max-drop 5] [--max-new-hotspots 0] [--github]";
function evaluate(city, gate, cmp) {
  const h = cmp?.after ?? health(city);
  const rules = [];
  if (gate.min !== void 0) {
    rules.push({
      name: "minimum health",
      ok: h.score >= gate.min,
      detail: `health ${h.score} ${h.score >= gate.min ? "\u2265" : "<"} ${gate.min}`
    });
  }
  if (cmp && gate.maxDrop !== void 0) {
    const drop = -cmp.delta;
    rules.push({
      name: "health drop",
      ok: drop <= gate.maxDrop,
      detail: `${cmp.before.score} \u2192 ${cmp.after.score} (${cmp.delta >= 0 ? "+" : ""}${cmp.delta}, allowed drop ${gate.maxDrop})`
    });
  }
  if (cmp && gate.maxNewHotspots !== void 0) {
    const n = cmp.newHotspots.length;
    rules.push({
      name: "new hotspots",
      ok: n <= gate.maxNewHotspots,
      detail: `${n} new hotspot${n === 1 ? "" : "s"} (allowed ${gate.maxNewHotspots})`
    });
  }
  return rules;
}
var escData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
function githubAnnotations(city, rules, cmp) {
  const out = [];
  for (const r of rules) {
    if (!r.ok) out.push(`::error title=${escProp(`Code health: ${r.name}`)}::${escData(r.detail)}`);
  }
  const hot = cmp ? cmp.newHotspots.map((path) => ({ path, title: "New hotspot" })) : (findings(city).find((f) => f.id === "hotspots")?.files ?? []).map((i) => ({
    path: city.files[i]?.path ?? "",
    title: "Hotspot"
  }));
  for (const { path, title } of hot.slice(0, 10)) {
    if (!path) continue;
    const f = city.files.find((x) => x.path === path);
    const msg = f ? `${f.loc.toLocaleString("en-US")} lines, ${f.churn} commits, ${f.fixes} fixes. Large and always changing: refactor or add tests before the next change.` : "Large and always changing.";
    out.push(`::warning file=${escProp(path)},title=${escProp(title)}::${escData(msg)}`);
  }
  return out;
}
async function checkCommand(argv, io) {
  let cityArg;
  let baselineArg;
  let gate;
  let github;
  try {
    const p = parseArgs(argv, [
      { name: "min-health" },
      { name: "baseline" },
      { name: "max-drop" },
      { name: "max-new-hotspots" },
      { name: "github", flag: true }
    ]);
    if (p.positionals.length > 1) throw new UsageError("check takes at most one city file");
    cityArg = p.positionals[0] ?? DEFAULT_CITY;
    baselineArg = stringOption(p, "baseline");
    gate = {
      min: intOption(p, "min-health", 0),
      maxDrop: intOption(p, "max-drop", 0),
      maxNewHotspots: intOption(p, "max-new-hotspots", 0)
    };
    if (gate.min !== void 0 && gate.min > 100) throw new UsageError("--min-health must be 0 to 100");
    if (!baselineArg && (gate.maxDrop !== void 0 || gate.maxNewHotspots !== void 0)) {
      throw new UsageError("--max-drop and --max-new-hotspots need --baseline");
    }
    github = p.options.has("github") || io.env?.GITHUB_ACTIONS === "true";
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}
usage: ${CHECK_USAGE}
`);
      return 2;
    }
    throw e;
  }
  const city = readCity(cityArg, io);
  if (!city) return 1;
  let cmp;
  if (baselineArg) {
    const base = readCity(baselineArg, io);
    if (!base) return 1;
    cmp = compareCities(base, city);
  }
  const h = cmp?.after ?? health(city);
  const rules = evaluate(city, gate, cmp);
  const failed = rules.filter((r) => !r.ok);
  const lines = [`git-cinematic check \xB7 ${city.repoName}`, "", `  health   ${h.score}/100 (grade ${h.grade})`];
  if (cmp) lines.push(`  baseline ${cmp.before.score}/100 (grade ${cmp.before.grade})`);
  if (rules.length) {
    lines.push("");
    for (const r of rules) lines.push(`  ${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(15)} ${r.detail}`);
  }
  lines.push("", failed.length ? `  \u2716 ${failed.length} of ${rules.length} checks failed` : "  \u2714 all checks passed", "");
  io.out(lines.join("\n"));
  if (github) {
    for (const a of githubAnnotations(city, rules, cmp)) io.out(`${a}
`);
    const output = io.env?.GITHUB_OUTPUT;
    if (output) appendFileSync(output, `health=${h.score}
grade=${h.grade}
passed=${failed.length === 0}
`);
    const summary = io.env?.GITHUB_STEP_SUMMARY;
    if (summary) {
      const gateTable = rules.length ? [
        "| Check | Result | Detail |",
        "|---|---|---|",
        ...rules.map((r) => `| ${r.name} | ${r.ok ? "\u2705 pass" : "\u274C fail"} | ${r.detail} |`),
        ""
      ].join("\n") : "";
      const since = cmp ? renderComparison(cmp) : void 0;
      appendFileSync(summary, `${gateTable}
${renderReport(city, { since })}
`);
    }
  }
  return failed.length ? 1 : 0;
}

// src/report.ts
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, relative as relative3, resolve as resolve4 } from "node:path";
var REPORT_USAGE = "git-cinematic report  [city=.cinematic/city.bin] [-o report.md] [--baseline old.bin]";
async function reportCommand(argv, io) {
  let cityArg;
  let outArg;
  let baselineArg;
  try {
    const p = parseArgs(argv, [{ name: "output", short: "o" }, { name: "baseline" }]);
    if (p.positionals.length > 1) throw new UsageError("report takes at most one city file");
    cityArg = p.positionals[0] ?? DEFAULT_CITY;
    outArg = stringOption(p, "output");
    baselineArg = stringOption(p, "baseline");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}
usage: ${REPORT_USAGE}
`);
      return 2;
    }
    throw e;
  }
  const city = readCity(cityArg, io);
  if (!city) return 1;
  let since;
  if (baselineArg) {
    const base = readCity(baselineArg, io);
    if (!base) return 1;
    since = renderComparison(compareCities(base, city));
  }
  const text = renderReport(city, { since });
  if (!outArg) {
    io.out(text);
    return 0;
  }
  const outPath = resolve4(io.cwd, outArg);
  mkdirSync3(dirname3(outPath), { recursive: true });
  writeFileSync3(outPath, text);
  const rel = relative3(io.cwd, outPath);
  io.out(`wrote ${rel && !rel.startsWith("..") ? rel : outPath}
`);
  return 0;
}

// src/view.ts
import { spawn as spawn3 } from "node:child_process";
import { createReadStream, existsSync as existsSync2, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve as resolve5, sep } from "node:path";
import { fileURLToPath } from "node:url";
var VIEW_USAGE = "git-cinematic view    [city=.cinematic/city.bin] [--port 4173] [--no-open]";
var CITY_ROUTE = "/local/city.bin";
var DEFAULT_CITY2 = ".cinematic/city.bin";
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
  const root = resolve5(opts.viewerDir);
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
      if (!existsSync2(opts.cityPath)) {
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
    if (existsSync2(file) && statSync(file).isFile()) {
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
  let cityPath = resolve5(io.cwd, cityArg || DEFAULT_CITY2);
  if (!cityArg && !existsSync2(cityPath)) {
    try {
      const { root } = await resolveRepo(io.cwd);
      cityPath = resolve5(root, DEFAULT_CITY2);
    } catch {
    }
  }
  if (!existsSync2(cityPath) || !statSync(cityPath).isFile()) {
    io.err(`error: no city file at ${cityPath}
run "git-cinematic analyze" first to create one
`);
    return 1;
  }
  const viewerDir = process.env.GIT_CINEMATIC_VIEWER ?? bundledViewerDir();
  if (!existsSync2(join(viewerDir, "index.html"))) {
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
  ${REPORT_USAGE}
  ${CHECK_USAGE}
  ${BADGE_USAGE}
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
    case "report":
      return reportCommand(rest, io);
    case "check":
      return checkCommand(rest, io);
    case "badge":
      return badgeCommand(rest, io);
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
  cwd: process.cwd(),
  env: process.env
}).then(
  (code2) => {
    process.exitCode = code2;
  },
  (e) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}
`);
    process.exitCode = 1;
  }
);
