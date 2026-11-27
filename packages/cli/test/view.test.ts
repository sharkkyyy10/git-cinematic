import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CITY_ROUTE, startViewServer, viewCommand } from "../src/view.js";

const dir = mkdtempSync(join(tmpdir(), "gc-view-"));
const viewer = join(dir, "viewer");
const city = join(dir, "city.bin");
let server: Server;
let base: string;

beforeAll(async () => {
  mkdirSync(join(viewer, "assets"), { recursive: true });
  writeFileSync(join(viewer, "index.html"), "<!doctype html><title>Git-Cinematic</title>");
  writeFileSync(join(viewer, "assets", "app.js"), "console.log(1)");
  writeFileSync(city, Buffer.from([0x1f, 0x8b, 1, 2, 3]));
  writeFileSync(join(dir, "secret.txt"), "nope");
  ({ server, url: base } = await startViewServer({ cityPath: city, viewerDir: viewer, port: 0 }));
});
afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("view server", () => {
  it("binds to 127.0.0.1 only", () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("serves the viewer, its assets and the city", async () => {
    const home = await fetch(base);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("<title>Git-Cinematic");
    const js = await fetch(new URL("/assets/app.js", base));
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const bin = await fetch(new URL(CITY_ROUTE, base));
    expect(bin.status).toBe(200);
    expect(new Uint8Array(await bin.arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b, 1, 2, 3]));
  });

  it("falls back to the app for client routes but not for missing assets", async () => {
    expect((await fetch(new URL("/gh/octo/demo", base))).status).toBe(200);
    expect((await fetch(new URL("/assets/missing.js", base))).status).toBe(404);
  });

  it("refuses to leave the viewer directory", async () => {
    const port = new URL(base).port;
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
      const res = await raw(p);
      expect(res.body).not.toBe("nope");
      expect([403, 404, 200]).toContain(res.status);
      if (res.status === 200) expect(res.body).toContain("<title>Git-Cinematic");
    }
  });

  it("moves to the next port when the requested one is busy", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as { port: number }).port;
    const { server: s, url } = await startViewServer({ cityPath: city, viewerDir: viewer, port: busy });
    expect(url).not.toContain(`:${busy}/`);
    s.close();
    blocker.close();
  });
});

describe("git-cinematic view", () => {
  const io = (out: string[], err: string[]) => ({
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    cwd: dir,
  });

  it("exits 1 when there is no city file and 2 on bad arguments", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await viewCommand(["missing.bin", "--no-open"], io(out, err))).toBe(1);
    expect(err.join("")).toContain("git-cinematic analyze");
    expect(await viewCommand(["--port", "x"], io(out, err))).toBe(2);
    expect(await viewCommand(["--port", "70000"], io(out, err))).toBe(2);
  });

  it("serves until the server closes and prints the viewer URL", async () => {
    const out: string[] = [];
    const err: string[] = [];
    process.env.GIT_CINEMATIC_VIEWER = viewer;
    const done = viewCommand([city, "--port", "0", "--no-open"], io(out, err), {
      onListening: async (url, s) => {
        expect(url).toMatch(/\?src=\/local\/city\.bin$/);
        expect((await fetch(url)).status).toBe(200);
        s.close();
      },
    });
    expect(await done).toBe(0);
    delete process.env.GIT_CINEMATIC_VIEWER;
    expect(out.join("")).toContain("/local/city.bin");
  });
});
