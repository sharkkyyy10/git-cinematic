import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepo } from "@git-cinematic/core";
import type { Io } from "./analyze.js";
import { intOption, parseArgs, UsageError } from "./args.js";

export const VIEW_USAGE = "git-cinematic view    [city=.cinematic/city.bin] [--port 4173] [--no-open]";
export const CITY_ROUTE = "/local/city.bin";
const DEFAULT_CITY = ".cinematic/city.bin";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

/** The viewer bundled next to the CLI at build time. */
export function bundledViewerDir(): string {
  return fileURLToPath(new URL("./viewer/", import.meta.url));
}

export interface ServeOptions {
  cityPath: string;
  viewerDir: string;
  port: number;
  /** Try the next ports when the requested one is taken. */
  portAttempts?: number;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string): void {
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const size = statSync(file).size;
  res.writeHead(200, {
    "content-type": type,
    "content-length": String(size),
    "cache-control": cache,
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

export function createViewServer(opts: Pick<ServeOptions, "cityPath" | "viewerDir">): Server {
  const root = resolve(opts.viewerDir);
  return createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "method not allowed");
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      send(res, 400, "bad request");
      return;
    }
    if (pathname === CITY_ROUTE) {
      if (!existsSync(opts.cityPath)) {
        send(res, 404, "city file not found");
        return;
      }
      serveFile(req, res, opts.cityPath, "no-store");
      return;
    }
    if (pathname === "/healthz") {
      send(res, 200, "ok");
      return;
    }
    const file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      send(res, 403, "forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isFile()) {
      serveFile(req, res, file, pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return;
    }
    // Client-side routes fall back to the app; missing assets stay 404.
    if (!extname(pathname) || pathname.endsWith(".html")) {
      serveFile(req, res, join(root, "index.html"), "no-cache");
      return;
    }
    send(res, 404, "not found");
  });
}

/** Listen on 127.0.0.1 only, moving to the next port if the requested one is busy. */
export async function startViewServer(opts: ServeOptions): Promise<{ server: Server; url: string }> {
  const attempts = opts.portAttempts ?? 10;
  for (let i = 0; i < attempts; i++) {
    const server = createViewServer(opts);
    const port = opts.port === 0 ? 0 : opts.port + i;
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolveListen());
      });
      const addr = server.address() as AddressInfo;
      return { server, url: `http://127.0.0.1:${addr.port}/` };
    } catch (e) {
      server.close();
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i === attempts - 1) throw e;
    }
  }
  throw new Error("no free port");
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed anyway.
  }
}

export async function viewCommand(
  argv: readonly string[],
  io: Io,
  hooks: { onListening?: (url: string, server: Server) => void } = {},
): Promise<number> {
  let cityArg: string;
  let port: number;
  let open: boolean;
  try {
    const p = parseArgs(argv, [{ name: "port" }, { name: "no-open", flag: true }]);
    if (p.positionals.length > 1) throw new UsageError("view takes at most one city file");
    cityArg = p.positionals[0] ?? "";
    port = intOption(p, "port", 0) ?? 4173;
    if (port > 65535) throw new UsageError("--port must be at most 65535");
    open = !p.options.has("no-open");
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nusage: ${VIEW_USAGE}\n`);
      return 2;
    }
    throw e;
  }
  let cityPath = resolve(io.cwd, cityArg || DEFAULT_CITY);
  if (!cityArg && !existsSync(cityPath)) {
    // Like analyze, default to the repository root's .cinematic/ when run from a subdirectory.
    try {
      const { root } = await resolveRepo(io.cwd);
      cityPath = resolve(root, DEFAULT_CITY);
    } catch {
      // Not in a repository; report the path in the working directory.
    }
  }
  if (!existsSync(cityPath) || !statSync(cityPath).isFile()) {
    io.err(`error: no city file at ${cityPath}\nrun "git-cinematic analyze" first to create one\n`);
    return 1;
  }
  const viewerDir = process.env.GIT_CINEMATIC_VIEWER ?? bundledViewerDir();
  if (!existsSync(join(viewerDir, "index.html"))) {
    io.err(`error: the viewer is missing from this installation (${viewerDir})\n`);
    return 1;
  }
  const { server, url } = await startViewServer({ cityPath, viewerDir, port });
  const pageUrl = `${url}?src=${CITY_ROUTE}`;
  io.out(`git-cinematic: serving ${cityPath}\n  ${pageUrl}\n  press Ctrl+C to stop\n`);
  if (open) openBrowser(pageUrl);
  hooks.onListening?.(pageUrl, server);
  return new Promise<number>((resolveExit) => {
    const stop = () => {
      server.close(() => resolveExit(0));
      server.closeAllConnections?.();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    server.once("close", () => resolveExit(0));
  });
}
