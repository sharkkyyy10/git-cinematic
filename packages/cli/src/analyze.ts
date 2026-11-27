import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  buildCity,
  buildModel,
  ERA_KIND_NAMES,
  FILE_DELETED,
  findings,
  GitError,
  headTime,
  health,
  hotspots,
  ingest,
  packCity,
  resolveRepo,
} from "@git-cinematic/core";
import { intOption, parseArgs, stringOption, UsageError } from "./args.js";
import { fmtBytes, fmtDate, fmtInt, truncateMiddle } from "./format-text.js";

export const ANALYZE_USAGE =
  "git-cinematic analyze [repo=.] [-o .cinematic/city.bin] [--since 2023-01-01] [--max-commits 50000] [--max-files 20000]";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
}

export async function analyzeCommand(argv: readonly string[], io: Io): Promise<number> {
  let repoArg: string;
  let outArg: string | undefined;
  let since: string | undefined;
  let maxCommits: number | undefined;
  let maxFiles: number | undefined;
  try {
    const p = parseArgs(argv, [
      { name: "output", short: "o" },
      { name: "since" },
      { name: "max-commits" },
      { name: "max-files" },
    ]);
    if (p.positionals.length > 1) throw new UsageError("analyze takes at most one repository path");
    repoArg = p.positionals[0] ?? ".";
    outArg = stringOption(p, "output");
    since = stringOption(p, "since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new UsageError("--since must be a date");
    maxCommits = intOption(p, "max-commits");
    maxFiles = intOption(p, "max-files");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nusage: ${ANALYZE_USAGE}\n`);
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
    const seconds = (performance.now() - started) / 1000;

    const deleted = city.files.filter((f) => f.flags & FILE_DELETED).length;
    const lines = [
      `git-cinematic · ${city.repoName}`,
      "",
      `  commits  ${fmtInt(model.commitCount)}    files  ${fmtInt(city.files.length)}${deleted ? ` (${fmtInt(deleted)} deleted)` : ""}    authors  ${fmtInt(city.authors.length)}    eras  ${city.eras.length}`,
    ];
    if (city.bucketStart.length) {
      lines.push(
        `  span     ${fmtDate(city.bucketStart[0] as number)} → ${fmtDate(city.generatedAt)} in ${city.bucketStart.length} buckets`,
      );
    }
    if (city.flags & 1)
      lines.push(`  note     smaller files folded into "(other)" buildings (--max-files ${maxFiles})`);
    const hp = health(city);
    lines.push(`  health   ${hp.score}/100 (grade ${hp.grade})  ·  details: git-cinematic report`);
    lines.push("", "  eras");
    for (const era of city.eras) {
      const from = fmtDate(city.bucketStart[era.startBucket] as number);
      lines.push(`    ${from}  ${ERA_KIND_NAMES[era.kind].padEnd(12)}  ${era.title.split(" · ")[1] ?? ""}`);
    }
    lines.push("", "  top hotspots (churn × size)");
    // Same rule as the findings: a file changed once or twice is not a hotspot.
    const top = hotspots(city.files)
      .filter((h) => h.score > 0 && (city.files[h.index]?.churn ?? 0) >= 3)
      .slice(0, 5);
    if (top.length === 0) lines.push("    none yet");
    top.forEach((h, i) => {
      const f = city.files[h.index];
      if (!f) return;
      lines.push(
        `    ${i + 1}. ${truncateMiddle(f.path, 52).padEnd(52)}  ${String(f.churn).padStart(5)} ${f.churn === 1 ? "commit " : "commits"}  ${fmtInt(f.loc).padStart(7)} lines`,
      );
    });
    const found = findings(city).filter((f) => f.id !== "hotspots");
    if (found.length) {
      lines.push("", "  findings");
      for (const f of found.slice(0, 4)) {
        lines.push(`    ${f.severity === "high" ? "!!" : f.severity === "medium" ? "! " : "· "} ${f.title}`);
      }
    }
    const rel = relative(io.cwd, outPath);
    const shown = rel && !rel.startsWith("..") ? rel : outPath;
    lines.push("", `  wrote ${shown} (${fmtBytes(bytes.length)}) in ${seconds.toFixed(1)} s`, "");
    io.out(lines.join("\n"));
    return 0;
  } catch (e) {
    if (e instanceof GitError && (e.code === "NOT_A_REPO" || e.code === "NO_COMMITS" || e.code === "GIT_MISSING")) {
      io.err(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
