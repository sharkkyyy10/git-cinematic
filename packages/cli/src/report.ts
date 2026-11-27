import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { compareCities, renderComparison, renderReport } from "@git-cinematic/core";
import type { Io } from "./analyze.js";
import { parseArgs, stringOption, UsageError } from "./args.js";
import { DEFAULT_CITY, readCity } from "./city-file.js";

export const REPORT_USAGE = "git-cinematic report  [city=.cinematic/city.bin] [-o report.md] [--baseline old.bin]";

/** Write the Markdown codebase report for a city file, to stdout or to a file. */
export async function reportCommand(argv: readonly string[], io: Io): Promise<number> {
  let cityArg: string;
  let outArg: string | undefined;
  let baselineArg: string | undefined;
  try {
    const p = parseArgs(argv, [{ name: "output", short: "o" }, { name: "baseline" }]);
    if (p.positionals.length > 1) throw new UsageError("report takes at most one city file");
    cityArg = p.positionals[0] ?? DEFAULT_CITY;
    outArg = stringOption(p, "output");
    baselineArg = stringOption(p, "baseline");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nusage: ${REPORT_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const city = readCity(cityArg, io);
  if (!city) return 1;
  let since: string | undefined;
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
  const outPath = resolve(io.cwd, outArg);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  const rel = relative(io.cwd, outPath);
  io.out(`wrote ${rel && !rel.startsWith("..") ? rel : outPath}\n`);
  return 0;
}
