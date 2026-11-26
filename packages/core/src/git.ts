import { spawn } from "node:child_process";

export type GitErrorCode = "NOT_A_REPO" | "NO_COMMITS" | "GIT_FAILED" | "GIT_MISSING";

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Run git and collect stdout as a Buffer. Rejects with a GitError on a non-zero exit. */
export function git(repo: string, args: string[], input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(new GitError(e.code === "ENOENT" ? "GIT_MISSING" : "GIT_FAILED", `could not run git: ${e.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError("GIT_FAILED", Buffer.concat(err).toString("utf8").trim() || `git exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Resolve the repository top level, or throw NOT_A_REPO / NO_COMMITS. */
export async function resolveRepo(repo: string): Promise<{ root: string; head: string }> {
  let root: string;
  try {
    root = (await git(repo, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  } catch (e) {
    if (e instanceof GitError && e.code === "GIT_MISSING") throw e;
    throw new GitError("NOT_A_REPO", `${repo} is not inside a git repository`);
  }
  try {
    const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).toString("utf8").trim();
    return { root, head };
  } catch {
    throw new GitError("NO_COMMITS", `${root} has no commits yet`);
  }
}
