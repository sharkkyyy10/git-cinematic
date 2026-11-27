// Insights: per-file signals for the lenses, a heuristic health score, plain-language findings
// and a Markdown report. Browser-safe: depends only on the city format, so the CLI, the viewer and
// the report all compute exactly the same numbers.

import {
  type City,
  type CityFile,
  ERA_KIND_NAMES,
  FILE_BINARY,
  FILE_DELETED,
  hotspots,
  noiseKind,
  rankPercentile,
} from "./format.js";

export const LENS_IDS = ["risk", "bugs", "silos", "coupling", "age"] as const;
export type LensId = (typeof LENS_IDS)[number];

export interface LensInfo {
  id: LensId;
  label: string;
  question: string;
  low: string;
  high: string;
  explain: string;
}

export const LENSES: readonly LensInfo[] = [
  {
    id: "risk",
    label: "Risk",
    question: "Where will the next problem come from?",
    low: "small or quiet",
    high: "large and always changing",
    explain:
      "Hotspot score: how large a file is times how often it changes, both as rank percentiles. Most defects and slow reviews concentrate in a few such files.",
  },
  {
    id: "bugs",
    label: "Bugs",
    question: "Which files keep needing fixes?",
    low: "no fixes",
    high: "many fixes",
    explain:
      "Fix commits touching the file (messages like fix, bug, hotfix, revert), weighted by how large a share of its changes were fixes.",
  },
  {
    id: "silos",
    label: "Silos",
    question: "Which busy files depend on one person?",
    low: "shared knowledge",
    high: "one author, lots of change",
    explain:
      "Files with a single author ranked by how often they change; two-author files count a little. If that person leaves, nobody else knows this code.",
  },
  {
    id: "coupling",
    label: "Coupling",
    question: "Which files drag others along when they change?",
    low: "independent",
    high: "changes with everything",
    explain:
      "Co-change centrality (PageRank over files committed together). Edits here ripple into many other files and need wider review.",
  },
  {
    id: "age",
    label: "Age",
    question: "What has nobody touched in a long time?",
    low: "changed recently",
    high: "untouched for longest",
    explain:
      "Time since the file last visibly changed, relative to the whole history. Old, large files are either rock-solid or forgotten.",
  },
];

export type Signals = Record<LensId, Float32Array> & {
  /** Bucket of the last visible change per file, -1 if the file never had lines. */
  lastChange: Int32Array;
  /** Fix heat at the last bucket, 0..1. */
  heatNow: Float32Array;
};

export const HOT_NOW = 0.25;
/** Hotspot score (percentile of size × percentile of churn) a file needs to be called a hotspot. */
export const HOTSPOT_MIN = 0.8;
export const BIG_FILE_LINES = 1000;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A file that exists now, is not noise (lock files, changelogs, generated, vendored) and so is analysed. */
export function isCounted(f: Pick<CityFile, "flags" | "loc" | "path">): boolean {
  return isAlive(f) && noiseKind(f.path) === null;
}

export function isAlive(f: Pick<CityFile, "flags" | "loc">): boolean {
  return (f.flags & FILE_DELETED) === 0 && f.loc > 0;
}

/** Per-file values in 0..1 for every lens, plus when each file last changed. */
export function fileSignals(city: City): Signals {
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
      if (loc !== prevLoc || heat > prevHeat) lastChange[i] = b;
      prevLoc = loc;
      prevHeat = heat;
    }
    if (B > 0) heatNow[i] = (h[(i * B + B - 1) * 2 + 1] ?? 0) / 65535;
  }

  const risk = new Float32Array(F);
  for (const s of hotspots(city.files)) risk[s.index] = s.score;

  const fixed = city.files.map((f) => (isCounted(f) ? f.fixes : 0));
  const fixPct = rankPercentile(fixed);
  const bugs = new Float32Array(F);
  city.files.forEach((f, i) => {
    if (!isCounted(f) || f.fixes === 0) return;
    const ratio = f.churn > 0 ? f.fixes / f.churn : 0;
    bugs[i] = clamp01(0.6 * (fixPct[i] ?? 0) + 0.4 * clamp01(ratio * 2));
  });

  const team = city.authors.length >= 2;
  const churnPct = rankPercentile(city.files.map((f) => (isCounted(f) ? f.churn : 0)));
  const silos = new Float32Array(F);
  if (team) {
    city.files.forEach((f, i) => {
      if (!isCounted(f) || f.churn === 0) return;
      if (f.authors === 1) silos[i] = churnPct[i] ?? 0;
      else if (f.authors === 2) silos[i] = 0.4 * (churnPct[i] ?? 0);
    });
  }

  const coupling = new Float32Array(F);
  const age = new Float32Array(F);
  city.files.forEach((f, i) => {
    if (!isCounted(f)) return;
    coupling[i] = clamp01(f.centrality);
    const last = lastChange[i] ?? -1;
    age[i] = B > 1 && last >= 0 ? (B - 1 - last) / (B - 1) : 0;
  });

  return { risk, bugs, silos, coupling, age, lastChange, heatNow };
}

// ---- health ------------------------------------------------------------------------------------

export interface HealthPart {
  id: "fixLoad" | "knowledge" | "fireNow" | "fileSize";
  label: string;
  /** 0..1, higher is healthier. */
  score: number;
  detail: string;
  weight: number;
}

export interface Health {
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  parts: HealthPart[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function gradeFor(score: number): Health["grade"] {
  return score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "E";
}

export function health(city: City, signals = fileSignals(city)): Health {
  const alive = city.files.map((f, i) => [f, i] as const).filter(([f]) => isCounted(f));
  const signal = city.files.filter((f) => noiseKind(f.path) === null);
  const totalChurn = signal.reduce((s, f) => s + f.churn, 0);
  const totalFixes = signal.reduce((s, f) => s + f.fixes, 0);
  const aliveLoc = alive.reduce((s, [f]) => s + f.loc, 0);

  const fixShare = totalChurn > 0 ? totalFixes / totalChurn : 0;
  const parts: HealthPart[] = [
    {
      id: "fixLoad",
      label: "Fix load",
      score: clamp01(1 - fixShare / 0.4),
      detail: `${pct(fixShare)} of file changes were bug fixes`,
      weight: 0.35,
    },
  ];
  if (city.authors.length >= 2) {
    const soloLoc = alive.filter(([f]) => f.authors === 1).reduce((s, [f]) => s + f.loc, 0);
    const share = aliveLoc > 0 ? soloLoc / aliveLoc : 0;
    parts.push({
      id: "knowledge",
      label: "Knowledge spread",
      score: clamp01(1 - share),
      detail: `${pct(share)} of the code has only one author`,
      weight: 0.25,
    });
  }
  const hot = alive.filter(([, i]) => (signals.heatNow[i] ?? 0) >= HOT_NOW).length;
  const hotShare = alive.length ? hot / alive.length : 0;
  parts.push({
    id: "fireNow",
    label: "Fires right now",
    score: clamp01(1 - hotShare / 0.15),
    detail: `${hot} of ${alive.length} files are hot with recent fixes`,
    weight: 0.2,
  });
  const bigLoc = alive.filter(([f]) => f.loc > BIG_FILE_LINES).reduce((s, [f]) => s + f.loc, 0);
  const bigShare = aliveLoc > 0 ? bigLoc / aliveLoc : 0;
  parts.push({
    id: "fileSize",
    label: "File size",
    score: clamp01(1 - bigShare / 0.5),
    detail: `${pct(bigShare)} of the code sits in files over ${BIG_FILE_LINES.toLocaleString("en-US")} lines`,
    weight: 0.2,
  });
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round((100 * parts.reduce((s, p) => s + p.score * p.weight, 0)) / totalWeight);
  return { score, grade: gradeFor(score), parts };
}

// ---- findings ----------------------------------------------------------------------------------

export interface Finding {
  id: "hotspots" | "bugs" | "silos" | "coupling" | "dormant" | "fire" | "solo";
  severity: "high" | "medium" | "low";
  title: string;
  why: string;
  action: string;
  /** File indexes, most important first (at most five). */
  files: number[];
  /** Every matching file, most important first. */
  matches: number[];
  lens?: LensId;
}

const TOP = 5;

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] as number;
}

export function findings(city: City, signals = fileSignals(city)): Finding[] {
  const out: Finding[] = [];
  const files = city.files;
  const alive = files.map((_, i) => i).filter((i) => isCounted(files[i] as CityFile));
  const by = (key: (i: number) => number) => (a: number, b: number) => key(b) - key(a) || a - b;
  const f = (i: number) => files[i] as CityFile;

  // A file changed once or twice is not a hotspot, however large; percentiles alone would say it is.
  // Findings name a short list a team can work through: the top slice, never fewer than five.
  const focus = (list: number[], share: number) => list.slice(0, Math.max(TOP, Math.ceil(alive.length * share)));
  const hot = focus(
    alive.filter((i) => (signals.risk[i] ?? 0) >= HOTSPOT_MIN && f(i).churn >= 3).sort(by((i) => signals.risk[i] ?? 0)),
    0.02,
  );
  if (hot.length) {
    out.push({
      id: "hotspots",
      severity: (signals.risk[hot[0] as number] ?? 0) >= 0.9 ? "high" : "medium",
      title: `${hot.length} hotspot${hot.length === 1 ? "" : "s"}: large files that never stop changing`,
      why: "Defects, merge conflicts and slow reviews concentrate in files that are both big and busy.",
      action: "Start refactoring and testing here: split the largest, and add tests before the next change.",
      files: hot.slice(0, TOP),
      matches: hot,
      lens: "risk",
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
      lens: "bugs",
    });
  }

  const buggy = focus(
    alive.filter((i) => f(i).fixes >= 2).sort(by((i) => f(i).fixes * 10 + (signals.bugs[i] ?? 0))),
    0.03,
  );
  if (buggy.length) {
    out.push({
      id: "bugs",
      severity: f(buggy[0] as number).fixes >= 5 ? "high" : "medium",
      title: `${buggy.length} bug-prone file${buggy.length === 1 ? "" : "s"}`,
      why: "Files fixed again and again are where users feel the bugs. A file's past fix rate is one of the best predictors of its future bugs.",
      action: "Give these files an owner, stronger tests and a review checklist.",
      files: buggy.slice(0, TOP),
      matches: buggy,
      lens: "bugs",
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
        lens: "silos",
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
      matches: [],
    });
  }

  const hubs = alive.filter((i) => f(i).centrality >= 0.6).sort(by((i) => f(i).centrality));
  if (hubs.length) {
    out.push({
      id: "coupling",
      severity: hubs.length >= 8 ? "medium" : "low",
      title: `${hubs.length} change magnet${hubs.length === 1 ? "" : "s"}: files that change together with many others`,
      why: "A change here usually means changes elsewhere too, so estimates slip and reviews grow.",
      action:
        "Check whether these are shared configs or real tangles; extract stable interfaces where they are tangles.",
      files: hubs.slice(0, TOP),
      matches: hubs,
      lens: "coupling",
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
      lens: "age",
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---- report ------------------------------------------------------------------------------------

const isoDate = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const md = (s: string) => s.replace(/([\\`*_[\]|<>])/g, "\\$1");
const int = (n: number) => Math.round(n).toLocaleString("en-US");

export interface ReportOptions {
  /** Markdown inserted after the health section, e.g. renderComparison() against a baseline. */
  since?: string;
}

/** A Markdown report a team lead or a client can read without opening the viewer. */
export function renderReport(city: City, opts: ReportOptions = {}): string {
  const signals = fileSignals(city);
  const hp = health(city, signals);
  const found = findings(city, signals);
  const alive = city.files.filter(isAlive);
  const deleted = city.files.filter((f) => f.flags & FILE_DELETED).length;
  const binary = alive.filter((f) => f.flags & FILE_BINARY).length;
  const B = city.bucketStart.length;
  const from = B ? isoDate(city.bucketStart[0] as number) : isoDate(city.generatedAt);
  const to = isoDate(city.generatedAt);
  const L: string[] = [];

  L.push(`# ${md(city.repoName)}: codebase report`, "");
  L.push(`Generated by Git-Cinematic from the history between ${from} and ${to}.`, "");
  L.push(`## Health: ${hp.score}/100 (grade ${hp.grade})`, "");
  L.push("| Signal | Score | What it measures |", "|---|---:|---|");
  for (const p of hp.parts) L.push(`| ${p.label} | ${Math.round(p.score * 100)} | ${md(p.detail)} |`);
  L.push(
    "",
    "The score is a heuristic. Use it to compare this repository with itself over time, not with other teams.",
    "",
  );
  if (opts.since) L.push(opts.since.trimEnd(), "");

  L.push("## At a glance", "");
  L.push(`- **${int(alive.length)}** files today, **${int(alive.reduce((s, f) => s + f.loc, 0))}** lines`);
  if (deleted) L.push(`- **${int(deleted)}** files that existed once and were deleted`);
  const noise = alive.filter((f) => noiseKind(f.path) !== null).length;
  if (noise)
    L.push(`- **${int(noise)}** lock files, changelogs, generated or vendored files (shown, but not analysed)`);
  if (binary) L.push(`- **${int(binary)}** binary files (shown, but not counted in lines)`);
  L.push(`- **${int(city.authors.length)}** author${city.authors.length === 1 ? "" : "s"}`);
  L.push(`- **${city.eras.length}** era${city.eras.length === 1 ? "" : "s"} in the history`, "");

  if (city.eras.length) {
    L.push("## The story so far", "", "| From | Era | Where most of the work went |", "|---|---|---|");
    for (const e of city.eras) {
      const start = isoDate(city.bucketStart[e.startBucket] ?? city.generatedAt);
      L.push(`| ${start} | ${ERA_KIND_NAMES[e.kind]} | ${md(e.title.split(" · ")[1] ?? "")} |`);
    }
    L.push("");
  }

  L.push("## Findings", "");
  if (found.length === 0) L.push("Nothing stands out yet. Come back when there is more history.", "");
  for (const x of found) {
    L.push(`### ${x.severity === "high" ? "🔴" : x.severity === "medium" ? "🟠" : "🔵"} ${md(x.title)}`, "");
    L.push(`**Why it matters:** ${x.why}`, "", `**What to do:** ${x.action}`, "");
    if (x.files.length) {
      L.push("| File | Lines | Commits | Fixes | Authors |", "|---|---:|---:|---:|---:|");
      for (const i of x.files) {
        const f = city.files[i];
        if (f)
          L.push(
            `| \`${f.path.replace(/`/g, "'")}\` | ${int(f.loc)} | ${int(f.churn)} | ${int(f.fixes)} | ${int(f.authors)} |`,
          );
      }
      L.push("");
    }
  }

  L.push("## How to read this", "");
  for (const l of LENSES) L.push(`- **${l.label}:** ${l.explain}`);
  L.push(
    "",
    "Commits that touch more than 50 files (reformats, vendor drops, bulk renames) are left out of churn, fixes and coupling.",
    "The analysis ran locally. It reads file paths, line counts, author display names and commit subjects; no source code or messages are stored.",
    "",
  );
  return L.join("\n");
}
