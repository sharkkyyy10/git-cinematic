import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { CityFormatError, renderReport, unpackCity } from "@git-cinematic/core";
import type { Io } from "./analyze.js";
import { parseArgs, stringOption, UsageError } from "./args.js";

export const REPORT_USAGE = "git-cinematic report  [city=.cinematic/city.bin] [-o report.md]";

/** Write the Markdown codebase report for a city file, to stdout or to a file. */
export async function reportCommand(argv: readonly string[], io: Io): Promise<number> {
  let cityArg: string;
  let outArg: string | undefined;
  try {
    const p = parseArgs(argv, [{ name: "output", short: "o" }]);
    if (p.positionals.length > 1) throw new UsageError("report takes at most one city file");
    cityArg = p.positionals[0] ?? ".cinematic/city.bin";
    outArg = stringOption(p, "output");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nusage: ${REPORT_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const cityPath = resolve(io.cwd, cityArg);
  if (!existsSync(cityPath)) {
    io.err(`error: no city file at ${cityArg}; run git-cinematic analyze first\n`);
    return 1;
  }
  let text: string;
  try {
    text = renderReport(unpackCity(readFileSync(cityPath)));
  } catch (e) {
    if (e instanceof CityFormatError || (e instanceof Error && /incorrect header|invalid/i.test(e.message))) {
      io.err(`error: ${cityArg} is not a valid city file (${e.message})\n`);
      return 1;
    }
    throw e;
  }
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
