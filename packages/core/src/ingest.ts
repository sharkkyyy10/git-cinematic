import { spawn } from "node:child_process";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { GitError, git, resolveRepo } from "./git.js";

export interface FileChange {
  fileId: number;
  added: number;
  deleted: number;
}

export interface CommitEvent {
  sha: string;
  time: number;
  authorIndex: number;
  subject: string;
  changes: FileChange[];
}

export interface IngestFile {
  /** Path at HEAD, or the last path the file had before it was deleted. */
  path: string;
  binary: boolean;
  /** Lines at HEAD; 0 when deleted; null when the blob was too large to count. */
  loc: number | null;
  /** True when the file no longer exists at HEAD. */
  deleted: boolean;
}

export interface Author {
  name: string;
  email: string;
}

export interface IngestResult {
  repoName: string;
  head: string;
  commits: CommitEvent[];
  files: IngestFile[];
  authors: Author[];
}

export interface IngestOptions {
  since?: string;
  maxCommits?: number;
}

const RS = "\x1e";
const US = "\x1f";
export const MAX_COUNTED_BLOB = 2 * 1024 * 1024;
const BINARY_SNIFF = 8000;

/** Turns NUL-separated `git log -z --numstat` output into commit events, incrementally. */
export class LogParser {
  readonly commits: CommitEvent[] = [];
  readonly authors: Author[] = [];
  /** Current path → file id. A rename moves the id to the new path. */
  readonly pathToId = new Map<string, number>();
  /** Latest path per file id. */
  readonly idToPath: string[] = [];
  readonly binary: boolean[] = [];

  private readonly authorByEmail = new Map<string, number>();
  private current: CommitEvent | null = null;
  private pendingRename: { added: number; deleted: number; bin: boolean; old?: string } | null = null;
  private rest = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: Buffer | string): void {
    const text = this.rest + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    let start = 0;
    for (let i = text.indexOf("\0"); i !== -1; i = text.indexOf("\0", start)) {
      this.token(text.slice(start, i));
      start = i + 1;
    }
    this.rest = text.slice(start);
  }

  end(): CommitEvent[] {
    const tail = this.rest + this.decoder.end();
    this.rest = "";
    if (tail.length > 0) this.token(tail);
    this.flush();
    return this.commits;
  }

  private token(raw: string): void {
    if (this.pendingRename) {
      const p = this.pendingRename;
      if (p.old === undefined) {
        p.old = raw;
        return;
      }
      this.pendingRename = null;
      this.rename(p.old, raw, p.added, p.deleted, p.bin);
      return;
    }
    const tok = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (tok.length === 0) return;
    if (tok.startsWith(RS)) {
      this.flush();
      this.header(tok.slice(1));
      return;
    }
    const t1 = tok.indexOf("\t");
    const t2 = t1 === -1 ? -1 : tok.indexOf("\t", t1 + 1);
    if (t2 === -1 || !this.current) return;
    const a = tok.slice(0, t1);
    const d = tok.slice(t1 + 1, t2);
    const path = tok.slice(t2 + 1);
    const bin = a === "-" || d === "-";
    const added = bin ? 0 : Number.parseInt(a, 10) || 0;
    const deleted = bin ? 0 : Number.parseInt(d, 10) || 0;
    if (path.length === 0) {
      this.pendingRename = { added, deleted, bin };
      return;
    }
    this.change(this.idFor(path), added, deleted, bin);
  }

  private header(h: string): void {
    const parts = h.split(US);
    const sha = parts[0] ?? "";
    const time = Number.parseInt(parts[1] ?? "0", 10) || 0;
    const name = parts[2] ?? "";
    const email = (parts[3] ?? "").toLowerCase();
    const subject = parts.slice(4).join(US);
    let authorIndex = this.authorByEmail.get(email);
    if (authorIndex === undefined) {
      authorIndex = this.authors.length;
      this.authorByEmail.set(email, authorIndex);
      this.authors.push({ name, email });
    } else {
      // Commits arrive oldest first, so the last name seen is the most recent.
      (this.authors[authorIndex] as Author).name = name;
    }
    this.current = { sha, time, authorIndex, subject, changes: [] };
  }

  private flush(): void {
    if (!this.current) return;
    const merged = new Map<number, FileChange>();
    for (const c of this.current.changes) {
      const m = merged.get(c.fileId);
      if (m) {
        m.added += c.added;
        m.deleted += c.deleted;
      } else merged.set(c.fileId, { ...c });
    }
    this.current.changes = [...merged.values()];
    this.commits.push(this.current);
    this.current = null;
  }

  private idFor(path: string): number {
    let id = this.pathToId.get(path);
    if (id === undefined) {
      id = this.idToPath.length;
      this.idToPath.push(path);
      this.binary.push(false);
      this.pathToId.set(path, id);
    }
    return id;
  }

  private rename(oldPath: string, newPath: string, added: number, deleted: number, bin: boolean): void {
    let id = this.pathToId.get(oldPath);
    if (id === undefined) id = this.idFor(newPath);
    else {
      this.pathToId.delete(oldPath);
      this.pathToId.set(newPath, id);
      this.idToPath[id] = newPath;
    }
    this.change(id, added, deleted, bin);
  }

  private change(fileId: number, added: number, deleted: number, bin: boolean): void {
    if (bin) this.binary[fileId] = true;
    this.current?.changes.push({ fileId, added, deleted });
  }
}

function streamGit(repo: string, args: string[], onData: (chunk: Buffer) => void, input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repo, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const err: Buffer[] = [];
    child.stdout.on("data", onData);
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => reject(new GitError("GIT_FAILED", `could not run git: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new GitError("GIT_FAILED", Buffer.concat(err).toString("utf8").trim() || `git exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export interface HeadBlob {
  sha: string;
  size: number;
}

/** Map of path → blob for every regular file at HEAD. */
export async function listHead(repo: string): Promise<Map<string, HeadBlob>> {
  const out = (await git(repo, ["ls-tree", "-r", "-l", "-z", "HEAD"])).toString("utf8");
  const map = new Map<string, HeadBlob>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [, type, sha, size] = entry.slice(0, tab).split(/ +/);
    if (type !== "blob" || !sha) continue;
    map.set(entry.slice(tab + 1), { sha, size: Number.parseInt(size ?? "0", 10) || 0 });
  }
  return map;
}

export interface BlobStats {
  lines: number;
  binary: boolean;
}

/** Count newlines and sniff for binary content with a single streamed `git cat-file --batch`. */
export async function countBlobs(repo: string, shas: string[]): Promise<Map<string, BlobStats>> {
  const result = new Map<string, BlobStats>();
  if (shas.length === 0) return result;
  let header: Buffer[] = [];
  let remaining = -1; // content bytes left; -1 = reading a header; -2 = expecting the trailing LF
  let sha = "";
  let seen = 0;
  let lines = 0;
  let binary = false;
  const finish = () => {
    result.set(sha, { lines, binary });
    remaining = -2;
  };
  const onData = (chunk: Buffer) => {
    let i = 0;
    while (i < chunk.length) {
      if (remaining === -2) {
        i++; // trailing LF after content
        remaining = -1;
        continue;
      }
      if (remaining === -1) {
        const nl = chunk.indexOf(10, i);
        if (nl === -1) {
          header.push(chunk.subarray(i));
          return;
        }
        header.push(chunk.subarray(i, nl));
        const line = Buffer.concat(header).toString("utf8");
        header = [];
        i = nl + 1;
        const [s, type, size] = line.split(" ");
        if (type === "missing" || size === undefined) continue;
        sha = s ?? "";
        remaining = Number.parseInt(size, 10) || 0;
        seen = 0;
        lines = 0;
        binary = false;
        if (remaining === 0) finish();
        continue;
      }
      const take = Math.min(remaining, chunk.length - i);
      const part = chunk.subarray(i, i + take);
      if (seen < BINARY_SNIFF && !binary) {
        const sniff = part.subarray(0, BINARY_SNIFF - seen);
        if (sniff.indexOf(0) !== -1) binary = true;
      }
      for (let p = part.indexOf(10); p !== -1; p = part.indexOf(10, p + 1)) lines++;
      seen += take;
      remaining -= take;
      i += take;
      if (remaining === 0) finish();
    }
  };
  await streamGit(repo, ["cat-file", "--batch"], onData, `${shas.join("\n")}\n`);
  return result;
}

/** Read the full history and the state of HEAD. */
export async function ingest(repo: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const { root, head } = await resolveRepo(repo);
  const args = ["log", "--reverse", "--no-merges", "-M", "--numstat", "-z", "--no-color", "--no-ext-diff"];
  if (opts.maxCommits !== undefined) args.push(`--max-count=${opts.maxCommits}`);
  if (opts.since !== undefined) args.push(`--since=${opts.since}`);
  args.push(`--format=${RS}%H${US}%at${US}%an${US}%ae${US}%s`, "HEAD");

  const parser = new LogParser();
  await streamGit(root, args, (c) => parser.push(c));
  const commits = parser.end();

  const headFiles = await listHead(root);
  // Files present at HEAD but untouched inside the window still belong to the city.
  for (const path of [...headFiles.keys()].sort()) {
    if (!parser.pathToId.has(path)) {
      parser.pathToId.set(path, parser.idToPath.length);
      parser.idToPath.push(path);
      parser.binary.push(false);
    }
  }

  const small = new Set<string>();
  for (const blob of headFiles.values()) if (blob.size <= MAX_COUNTED_BLOB) small.add(blob.sha);
  const stats = await countBlobs(root, [...small].sort());

  const files: IngestFile[] = parser.idToPath.map((path, id) => {
    const blob = parser.pathToId.get(path) === id ? headFiles.get(path) : undefined;
    if (!blob) return { path, binary: parser.binary[id] ?? false, loc: 0, deleted: true };
    const s = stats.get(blob.sha);
    const binary = (parser.binary[id] ?? false) || (s?.binary ?? false);
    return { path, binary, loc: binary ? 0 : s ? s.lines : null, deleted: false };
  });

  return { repoName: basename(root), head, commits, files, authors: parser.authors };
}
