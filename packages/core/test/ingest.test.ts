import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "../src/git.js";
import { type IngestResult, ingest, LogParser } from "../src/ingest.js";
import { createFixture, type Fixture, lines } from "./helpers.js";

let fx: Fixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function fileId(r: IngestResult, path: string): number {
  const id = r.files.findIndex((f) => f.path === path);
  expect(id, `file ${path}`).toBeGreaterThanOrEqual(0);
  return id;
}

describe("ingest", () => {
  it("records plain adds and deletes with fixed dates", async () => {
    fx = createFixture();
    fx.write("src/a.ts", lines(10));
    fx.write("src/b.ts", lines(4));
    fx.commit("feat: add a and b", 0);
    fx.write("src/a.ts", lines(7));
    fx.commit("refactor: shrink a", 3);
    fx.remove("src/b.ts");
    fx.commit("chore: drop b", 9);

    const r = await ingest(fx.dir);
    expect(r.commits).toHaveLength(3);
    expect(r.commits.map((c) => c.time)).toEqual([0, 3, 9].map((d) => Date.UTC(2024, 0, 1) / 1000 + d * 86400));
    const a = fileId(r, "src/a.ts");
    const b = fileId(r, "src/b.ts");
    expect(r.commits[0]?.changes).toEqual(
      expect.arrayContaining([
        { fileId: a, added: 10, deleted: 0 },
        { fileId: b, added: 4, deleted: 0 },
      ]),
    );
    expect(r.commits[1]?.changes).toEqual([{ fileId: a, added: 0, deleted: 3 }]);
    expect(r.commits[2]?.changes).toEqual([{ fileId: b, added: 0, deleted: 4 }]);
    expect(r.files[a]).toMatchObject({ loc: 7, deleted: false, binary: false });
    expect(r.files[b]).toMatchObject({ loc: 0, deleted: true });
    expect(r.commits[0]?.subject).toBe("feat: add a and b");
  });

  it("follows a rename with one file id through later edits", async () => {
    fx = createFixture();
    fx.write("old/name.ts", lines(40));
    fx.commit("feat: add name", 0);
    fx.move("old/name.ts", "new/renamed.ts");
    fx.commit("refactor: move file", 1);
    fx.write("new/renamed.ts", lines(45));
    fx.commit("feat: extend", 2);

    const r = await ingest(fx.dir);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: "new/renamed.ts", loc: 45, deleted: false });
    const ids = r.commits.flatMap((c) => c.changes.map((ch) => ch.fileId));
    expect(new Set(ids)).toEqual(new Set([0]));
    expect(r.commits[2]?.changes).toEqual([{ fileId: 0, added: 5, deleted: 0 }]);
  });

  it("flags binary files and counts them as zero lines", async () => {
    fx = createFixture();
    fx.write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2, 3, 10, 0, 10]));
    fx.write("readme.md", lines(2));
    fx.commit("docs: add logo", 0);
    const r = await ingest(fx.dir);
    const png = r.files[fileId(r, "logo.png")];
    expect(png).toMatchObject({ binary: true, loc: 0, deleted: false });
    expect(r.commits[0]?.changes.find((c) => r.files[c.fileId]?.path === "logo.png")).toMatchObject({
      added: 0,
      deleted: 0,
    });
    expect(r.files[fileId(r, "readme.md")]).toMatchObject({ binary: false, loc: 2 });
  });

  it("keys authors by lower-cased email and keeps the most recent name", async () => {
    fx = createFixture();
    fx.write("a.txt", "1\n");
    fx.commit("one", 0, { name: "Old Name", email: "Dev@Example.com" });
    fx.write("a.txt", "1\n2\n");
    fx.commit("two", 1, { name: "New Name", email: "dev@example.com" });
    fx.write("a.txt", "1\n2\n3\n");
    fx.commit("three", 2, { name: "Other", email: "other@example.com" });
    const r = await ingest(fx.dir);
    expect(r.authors).toEqual([
      { name: "New Name", email: "dev@example.com" },
      { name: "Other", email: "other@example.com" },
    ]);
    expect(r.commits.map((c) => c.authorIndex)).toEqual([0, 0, 1]);
  });

  it("honours --max-commits (newest n) and --since", async () => {
    fx = createFixture();
    for (let i = 0; i < 5; i++) {
      fx.write("a.txt", lines(i + 1));
      fx.commit(`c${i}`, i * 10);
    }
    const newest = await ingest(fx.dir, { maxCommits: 2 });
    expect(newest.commits.map((c) => c.subject)).toEqual(["c3", "c4"]);
    const since = await ingest(fx.dir, { since: "2024-01-25" });
    expect(since.commits.map((c) => c.subject)).toEqual(["c3", "c4"]);
    expect(since.files[0]?.loc).toBe(5);
  });

  it("rejects a directory that is not a repository, and an empty repository", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const plain = mkdtempSync(join(tmpdir(), "gc-plain-"));
    try {
      await expect(ingest(plain)).rejects.toMatchObject({ code: "NOT_A_REPO" });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    fx = createFixture();
    await expect(ingest(fx.dir)).rejects.toBeInstanceOf(GitError);
    await expect(ingest(fx.dir)).rejects.toMatchObject({ code: "NO_COMMITS" });
  });
});

describe("LogParser", () => {
  it("parses tokens split across arbitrary chunk boundaries", () => {
    const raw =
      "\x1eaaa\x1f100\x1fAda\x1fada@x\x1ffirst\0\n3\t1\tsrc/a.ts\0-\t-\timg.png\0" +
      "\x1ebbb\x1f200\x1fAda\x1fada@x\x1fmove\0\n0\t0\t\0src/a.ts\0lib/a.ts\0" +
      "\x1eccc\x1f300\x1fBo\x1fbo@x\x1fempty\0";
    for (const size of [1, 2, 3, 7, raw.length]) {
      const p = new LogParser();
      const buf = Buffer.from(raw, "utf8");
      for (let i = 0; i < buf.length; i += size) p.push(buf.subarray(i, i + size));
      const commits = p.end();
      expect(commits.map((c) => c.sha)).toEqual(["aaa", "bbb", "ccc"]);
      expect(commits[0]?.changes).toEqual([
        { fileId: 0, added: 3, deleted: 1 },
        { fileId: 1, added: 0, deleted: 0 },
      ]);
      expect(commits[1]?.changes).toEqual([{ fileId: 0, added: 0, deleted: 0 }]);
      expect(commits[2]?.changes).toEqual([]);
      expect(p.idToPath).toEqual(["lib/a.ts", "img.png"]);
      expect(p.binary).toEqual([false, true]);
    }
  });

  it("decodes multi-byte UTF-8 paths split mid-character", () => {
    const raw = Buffer.from("\x1eaaa\x1f1\x1fA\x1fa@x\x1fs\0\n1\t0\tdocs/résumé-日本.md\0", "utf8");
    const p = new LogParser();
    for (let i = 0; i < raw.length; i++) p.push(raw.subarray(i, i + 1));
    p.end();
    expect(p.idToPath).toEqual(["docs/résumé-日本.md"]);
  });
});
