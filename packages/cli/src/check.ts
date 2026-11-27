import { appendFileSync } from "node:fs";
import {
  type City,
  type Comparison,
  compareCities,
  findings,
  health,
  renderComparison,
  renderReport,
} from "@git-cinematic/core";
import type { Io } from "./analyze.js";
import { intOption, parseArgs, stringOption, UsageError } from "./args.js";
import { DEFAULT_CITY, readCity } from "./city-file.js";

export const CHECK_USAGE =
  "git-cinematic check   [city=.cinematic/city.bin] [--min-health 60] [--baseline old.bin] [--max-drop 5] [--max-new-hotspots 0] [--github]";

export interface Rule {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Gate {
  min?: number;
  maxDrop?: number;
  maxNewHotspots?: number;
}

/** Evaluate the quality gate. Rules that need a baseline are skipped without one. */
export function evaluate(city: City, gate: Gate, cmp?: Comparison): Rule[] {
  const h = cmp?.after ?? health(city);
  const rules: Rule[] = [];
  if (gate.min !== undefined) {
    rules.push({
      name: "minimum health",
      ok: h.score >= gate.min,
      detail: `health ${h.score} ${h.score >= gate.min ? "≥" : "<"} ${gate.min}`,
    });
  }
  if (cmp && gate.maxDrop !== undefined) {
    const drop = -cmp.delta;
    rules.push({
      name: "health drop",
      ok: drop <= gate.maxDrop,
      detail: `${cmp.before.score} → ${cmp.after.score} (${cmp.delta >= 0 ? "+" : ""}${cmp.delta}, allowed drop ${gate.maxDrop})`,
    });
  }
  if (cmp && gate.maxNewHotspots !== undefined) {
    const n = cmp.newHotspots.length;
    rules.push({
      name: "new hotspots",
      ok: n <= gate.maxNewHotspots,
      detail: `${n} new hotspot${n === 1 ? "" : "s"} (allowed ${gate.maxNewHotspots})`,
    });
  }
  return rules;
}

/** GitHub Actions workflow-command escaping. */
const escData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function githubAnnotations(city: City, rules: Rule[], cmp?: Comparison): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (!r.ok) out.push(`::error title=${escProp(`Code health: ${r.name}`)}::${escData(r.detail)}`);
  }
  const hot = cmp
    ? cmp.newHotspots.map((path) => ({ path, title: "New hotspot" }))
    : (findings(city).find((f) => f.id === "hotspots")?.files ?? []).map((i) => ({
        path: city.files[i]?.path ?? "",
        title: "Hotspot",
      }));
  for (const { path, title } of hot.slice(0, 10)) {
    if (!path) continue;
    const f = city.files.find((x) => x.path === path);
    const msg = f
      ? `${f.loc.toLocaleString("en-US")} lines, ${f.churn} commits, ${f.fixes} fixes. Large and always changing: refactor or add tests before the next change.`
      : "Large and always changing.";
    out.push(`::warning file=${escProp(path)},title=${escProp(title)}::${escData(msg)}`);
  }
  return out;
}

export async function checkCommand(argv: readonly string[], io: Io): Promise<number> {
  let cityArg: string;
  let baselineArg: string | undefined;
  let gate: Gate;
  let github: boolean;
  try {
    const p = parseArgs(argv, [
      { name: "min-health" },
      { name: "baseline" },
      { name: "max-drop" },
      { name: "max-new-hotspots" },
      { name: "github", flag: true },
    ]);
    if (p.positionals.length > 1) throw new UsageError("check takes at most one city file");
    cityArg = p.positionals[0] ?? DEFAULT_CITY;
    baselineArg = stringOption(p, "baseline");
    gate = {
      min: intOption(p, "min-health", 0),
      maxDrop: intOption(p, "max-drop", 0),
      maxNewHotspots: intOption(p, "max-new-hotspots", 0),
    };
    if (gate.min !== undefined && gate.min > 100) throw new UsageError("--min-health must be 0 to 100");
    if (!baselineArg && (gate.maxDrop !== undefined || gate.maxNewHotspots !== undefined)) {
      throw new UsageError("--max-drop and --max-new-hotspots need --baseline");
    }
    github = p.options.has("github") || io.env?.GITHUB_ACTIONS === "true";
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nusage: ${CHECK_USAGE}\n`);
      return 2;
    }
    throw e;
  }

  const city = readCity(cityArg, io);
  if (!city) return 1;
  let cmp: Comparison | undefined;
  if (baselineArg) {
    const base = readCity(baselineArg, io);
    if (!base) return 1;
    cmp = compareCities(base, city);
  }
  const h = cmp?.after ?? health(city);
  const rules = evaluate(city, gate, cmp);
  const failed = rules.filter((r) => !r.ok);

  const lines = [`git-cinematic check · ${city.repoName}`, "", `  health   ${h.score}/100 (grade ${h.grade})`];
  if (cmp) lines.push(`  baseline ${cmp.before.score}/100 (grade ${cmp.before.grade})`);
  if (rules.length) {
    lines.push("");
    for (const r of rules) lines.push(`  ${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(15)} ${r.detail}`);
  }
  lines.push("", failed.length ? `  ✖ ${failed.length} of ${rules.length} checks failed` : "  ✔ all checks passed", "");
  io.out(lines.join("\n"));

  if (github) {
    for (const a of githubAnnotations(city, rules, cmp)) io.out(`${a}\n`);
    const output = io.env?.GITHUB_OUTPUT;
    if (output) appendFileSync(output, `health=${h.score}\ngrade=${h.grade}\npassed=${failed.length === 0}\n`);
    const summary = io.env?.GITHUB_STEP_SUMMARY;
    if (summary) {
      const gateTable = rules.length
        ? [
            "| Check | Result | Detail |",
            "|---|---|---|",
            ...rules.map((r) => `| ${r.name} | ${r.ok ? "✅ pass" : "❌ fail"} | ${r.detail} |`),
            "",
          ].join("\n")
        : "";
      const since = cmp ? renderComparison(cmp) : undefined;
      appendFileSync(summary, `${gateTable}\n${renderReport(city, { since })}\n`);
    }
  }
  return failed.length ? 1 : 0;
}
