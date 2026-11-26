import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BASE_TIME = Date.UTC(2024, 0, 1) / 1000;
const DAY = 86400;

export interface Fixture {
  dir: string;
  write(path: string, content: string | Buffer): void;
  remove(path: string): void;
  move(from: string, to: string): void;
  /** Commit everything with fixed author/committer dates (day offset from 2024-01-01). */
  commit(subject: string, day: number, author?: { name: string; email: string }): void;
  git(...args: string[]): string;
  cleanup(): void;
}

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

export function lines(n: number, prefix = "line"): string {
  let s = "";
  for (let i = 0; i < n; i++) s += `${prefix} ${i}\n`;
  return s;
}

export function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "gc-fixture-"));
  const run = (args: string[], env: NodeJS.ProcessEnv = ENV) =>
    execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      env,
      encoding: "utf8",
    });
  run(["init", "-q", "-b", "main"]);
  return {
    dir,
    write(path, content) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(path) {
      unlinkSync(join(dir, path));
    },
    move(from, to) {
      mkdirSync(dirname(join(dir, to)), { recursive: true });
      run(["mv", from, to]);
    },
    commit(subject, day, author = { name: "Ada", email: "ada@example.com" }) {
      const date = `${BASE_TIME + day * DAY} +0000`;
      run(["add", "-A"]);
      run(["commit", "-q", "--allow-empty", "-m", subject], {
        ...ENV,
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      });
    },
    git: (...args) => run(args),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
