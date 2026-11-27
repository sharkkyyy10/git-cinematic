import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { health, renderBadge } from "@git-cinematic/core";
import type { Io } from "./analyze.js";
import { parseArgs, stringOption, UsageError } from "./args.js";
import { DEFAULT_CITY, readCity } from "./city-file.js";

export const BADGE_USAGE =
  'git-cinematic badge   [city=.cinematic/city.bin] [-o .cinematic/health.svg] [--label "code health"]';

/** Write an SVG health badge for a README. */
export async function badgeCommand(argv: readonly string[], io: Io): Promise<number> {
  let cityArg: string;
  let outArg: string;
  let label: string;
  try {
    const p = parseArgs(argv, [{ name: "output", short: "o" }, { name: "label" }]);
    if (p.positionals.length > 1) throw new UsageError("badge takes at most one city file");
    cityArg = p.positionals[0] ?? DEFAULT_CITY;
    outArg = stringOption(p, "output") ?? ".cinematic/health.svg";
    label = stringOption(p, "label") ?? "code health";
    if (label.length === 0 || label.length > 40) throw new UsageError("--label must be 1 to 40 characters");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nusage: ${BADGE_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const city = readCity(cityArg, io);
  if (!city) return 1;
  const h = health(city);
  const outPath = resolve(io.cwd, outArg);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderBadge(h.score, label));
  const rel = relative(io.cwd, outPath);
  io.out(`wrote ${rel && !rel.startsWith("..") ? rel : outPath} (${h.score}/100, grade ${h.grade})\n`);
  return 0;
}
