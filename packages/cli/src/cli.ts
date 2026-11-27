import { PACKAGE_VERSION } from "@git-cinematic/core";
import { ANALYZE_USAGE, analyzeCommand, type Io } from "./analyze.js";

const HELP = `git-cinematic ${PACKAGE_VERSION}
Fly through your git history as a living 3D city.

usage:
  ${ANALYZE_USAGE}
  git-cinematic --version | --help

Nothing is uploaded: the city file holds paths, counts and scores, never file contents.
`;

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "analyze":
      return analyzeCommand(rest, io);
    case "--version":
    case "-v":
      io.out(`${PACKAGE_VERSION}\n`);
      return 0;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      io.out(HELP);
      return 0;
    default:
      io.err(`error: unknown command ${cmd}\n\n${HELP}`);
      return 2;
  }
}
