import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type City, unpackCity } from "@git-cinematic/core";
import type { Io } from "./analyze.js";

export const DEFAULT_CITY = ".cinematic/city.bin";

/** Read a city file, or print a friendly error and return null. */
export function readCity(arg: string, io: Io): City | null {
  const path = resolve(io.cwd, arg);
  if (!existsSync(path)) {
    io.err(`error: no city file at ${arg}; run git-cinematic analyze first\n`);
    return null;
  }
  try {
    return unpackCity(readFileSync(path));
  } catch (e) {
    io.err(`error: ${arg} is not a valid city file (${e instanceof Error ? e.message : String(e)})\n`);
    return null;
  }
}
