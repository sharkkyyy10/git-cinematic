import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unpackCity } from "@git-cinematic/core";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tmp = mkdtempSync(join(tmpdir(), "gc-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function run(argv: string[], cwd = repoRoot) {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (s) => (out += s), err: (s) => (err += s), cwd });
  return { code, out, err };
}

describe("git-cinematic analyze", () => {
  it("analyses this repository, exits 0 and prints a summary", async () => {
    const outFile = join(tmp, "self.bin");
    const r = await run(["analyze", ".", "-o", outFile]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/commits\s+\d+/);
    expect(r.out).toMatch(/files\s+\d+/);
    expect(r.out).toMatch(/authors\s+\d+/);
    expect(r.out).toMatch(/eras\s+\d+/);
    expect(r.out).toContain("top hotspots");
    expect(r.out).toMatch(/wrote .*self\.bin \([\d.]+ [KM]?B\) in [\d.]+ s/);
    const city = unpackCity(readFileSync(outFile));
    expect(city.files.some((f) => f.path === "packages/core/src/ingest.ts")).toBe(true);
  });

  it("writes identical bytes on a second run", async () => {
    const a = join(tmp, "a.bin");
    const b = join(tmp, "b.bin");
    await run(["analyze", "-o", a]);
    await run(["analyze", "-o", b]);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });

  it("folds small files with --max-files and flags the city as truncated", async () => {
    const outFile = join(tmp, "folded.bin");
    const r = await run(["analyze", "--max-files", "5", "-o", outFile]);
    expect(r.code).toBe(0);
    const city = unpackCity(readFileSync(outFile));
    expect(city.flags & 1).toBe(1);
    expect(city.files.some((f) => f.path.endsWith("(other)"))).toBe(true);
  });

  it("exits 1 outside a git repository", async () => {
    const r = await run(["analyze", tmp], tmp);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not inside a git repository/);
  });

  it("exits 2 on bad arguments", async () => {
    expect((await run(["analyze", "--max-commits", "abc"])).code).toBe(2);
    expect((await run(["analyze", "--bogus"])).code).toBe(2);
    expect((await run(["analyze", "--since", "not-a-date"])).code).toBe(2);
    expect((await run(["analyze", "a", "b"])).code).toBe(2);
    expect((await run(["frobnicate"])).code).toBe(2);
  });

  it("prints version and help", async () => {
    expect((await run(["--version"])).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect((await run(["--help"])).out).toContain("git-cinematic analyze");
  });
});

describe("git-cinematic report", () => {
  it("prints a Markdown report for a city and writes it with -o", async () => {
    const city = join(tmp, "for-report.bin");
    const a = await run(["analyze", "-o", city]);
    expect(a.out).toMatch(/health\s+\d+\/100 \(grade [A-E]\)/);
    const r = await run(["report", city]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^# git-cinematic: codebase report/);
    expect(r.out).toMatch(/## Health: \d+\/100/);
    const md = join(tmp, "out/report.md");
    const w = await run(["report", city, "-o", md]);
    expect(w.code).toBe(0);
    expect(readFileSync(md, "utf8")).toBe(r.out);
  });

  it("exits 1 without a city and on a corrupt one, 2 on bad arguments", async () => {
    expect((await run(["report", join(tmp, "missing.bin")])).code).toBe(1);
    const bad = join(tmp, "bad.bin");
    writeFileSync(bad, "not a city");
    const r = await run(["report", bad]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a valid city file/);
    expect((await run(["report", "a", "b"])).code).toBe(2);
    expect((await run(["report", "--nope"])).code).toBe(2);
  });
});
