// Compare two cities of the same repository (a baseline and now): what got better, what got worse.
// Browser-safe, like insights.ts. Files are matched by path.

import type { City } from "./format.js";
import { type Finding, fileSignals, findings, type Health, HOT_NOW, health, isCounted } from "./insights.js";

export interface FileDelta {
  path: string;
  before: number;
  after: number;
}

export interface Comparison {
  before: Health;
  after: Health;
  /** after.score - before.score */
  delta: number;
  /** Hotspots now that were not hotspots in the baseline, worst first. */
  newHotspots: string[];
  /** Hotspots in the baseline that are no longer hotspots (or no longer exist). */
  resolvedHotspots: string[];
  /** Files on fire now that were not on fire in the baseline. */
  newFires: string[];
  /** Files that grew the most, in lines. */
  grew: FileDelta[];
  /** Counted files added and removed since the baseline. */
  added: number;
  removed: number;
}

function hotspotPaths(city: City, found: Finding[]): string[] {
  const h = found.find((f) => f.id === "hotspots");
  return (h?.matches ?? []).map((i) => city.files[i]?.path ?? "").filter(Boolean);
}

export function compareCities(base: City, head: City): Comparison {
  const sb = fileSignals(base);
  const sh = fileSignals(head);
  const before = health(base, sb);
  const after = health(head, sh);
  const hb = new Set(hotspotPaths(base, findings(base, sb)));
  const hh = hotspotPaths(head, findings(head, sh));
  const hhSet = new Set(hh);

  const fireBefore = new Set(
    base.files.filter((f, i) => isCounted(f) && (sb.heatNow[i] ?? 0) >= HOT_NOW).map((f) => f.path),
  );
  const newFires = head.files
    .map((f, i) => [f, sh.heatNow[i] ?? 0] as const)
    .filter(([f, heat]) => isCounted(f) && heat >= HOT_NOW && !fireBefore.has(f.path))
    .sort((a, b) => b[1] - a[1] || (a[0].path < b[0].path ? -1 : 1))
    .map(([f]) => f.path);

  const locBefore = new Map(base.files.filter(isCounted).map((f) => [f.path, f.loc]));
  const countedNow = head.files.filter(isCounted);
  const grew = countedNow
    .map((f) => ({ path: f.path, before: locBefore.get(f.path) ?? 0, after: f.loc }))
    .filter((d) => d.after > d.before)
    .sort((a, b) => b.after - b.before - (a.after - a.before) || (a.path < b.path ? -1 : 1))
    .slice(0, 5);
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
    removed: [...locBefore.keys()].filter((p) => !nowPaths.has(p)).length,
  };
}

const code = (p: string) => `\`${p.replace(/`/g, "'")}\``;
const list = (paths: string[], max = 10) => {
  const lines = paths.slice(0, max).map((p) => `- ${code(p)}`);
  if (paths.length > max) lines.push(`- …and ${paths.length - max} more`);
  return lines;
};

/** The "since the baseline" section of a report. */
export function renderComparison(c: Comparison): string {
  const arrow = c.delta > 0 ? "▲" : c.delta < 0 ? "▼" : "▬";
  const L = [
    "## Since the baseline",
    "",
    `**Health ${c.before.score} → ${c.after.score}** (${arrow} ${c.delta > 0 ? "+" : ""}${c.delta}, grade ${c.before.grade} → ${c.after.grade})`,
    "",
    "| Signal | Before | Now |",
    "|---|---:|---:|",
  ];
  for (const p of c.after.parts) {
    const b = c.before.parts.find((x) => x.id === p.id);
    L.push(`| ${p.label} | ${b ? Math.round(b.score * 100) : "—"} | ${Math.round(p.score * 100)} |`);
  }
  L.push("", `${c.added} files added and ${c.removed} removed.`, "");
  if (c.newHotspots.length) L.push(`### New hotspots (${c.newHotspots.length})`, "", ...list(c.newHotspots), "");
  if (c.resolvedHotspots.length)
    L.push(`### Hotspots resolved (${c.resolvedHotspots.length})`, "", ...list(c.resolvedHotspots), "");
  if (c.newFires.length) L.push(`### Newly on fire (${c.newFires.length})`, "", ...list(c.newFires), "");
  if (c.grew.length) {
    L.push("### Grew the most", "", "| File | Lines before | Lines now |", "|---|---:|---:|");
    for (const g of c.grew)
      L.push(`| ${code(g.path)} | ${g.before.toLocaleString("en-US")} | ${g.after.toLocaleString("en-US")} |`);
    L.push("");
  }
  return L.join("\n");
}
