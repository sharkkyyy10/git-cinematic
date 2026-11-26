#!/usr/bin/env node
// Helper for scripts/deploy.sh. All HTTP happens in curl; this file only
// hashes files, writes request bodies and reads JSON responses.
//
//   node scripts/cf-assets.mjs manifest <assetDir> <workDir>
//   node scripts/cf-assets.mjs check    <response.json> <label>
//   node scripts/cf-assets.mjs get      <response.json> <dot.path>
//   node scripts/cf-assets.mjs buckets  <response.json> <workDir>
//   node scripts/cf-assets.mjs metadata <completionJwt> <compatDate> <out.json>
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const MIME = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  wasm: "application/wasm",
  txt: "text/plain",
  webmanifest: "application/manifest+json",
  bin: "application/octet-stream",
  map: "application/json",
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`could not parse JSON response in ${file}`);
  }
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "manifest": {
    const [assetDir, workDir] = args;
    if (!assetDir || !workDir) fail("usage: manifest <assetDir> <workDir>");
    const files = walk(assetDir);
    if (files.length === 0) fail(`no files in ${assetDir}`);
    if (!files.some((f) => relative(assetDir, f) === "index.html")) fail(`${assetDir}/index.html missing`);
    mkdirSync(join(workDir, "b64"), { recursive: true });
    const manifest = {};
    const index = {};
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes.length > MAX_FILE_BYTES) fail(`${file} exceeds 25 MiB`);
      const b64 = bytes.toString("base64");
      const ext = extname(file).slice(1).toLowerCase();
      const hash = createHash("sha256").update(b64 + ext).digest("hex").slice(0, 32);
      const key = `/${relative(assetDir, file).split(sep).join("/")}`;
      manifest[key] = { hash, size: bytes.length };
      index[hash] = { path: key, type: MIME[ext] ?? "application/octet-stream" };
      writeFileSync(join(workDir, "b64", `${hash}.b64`), b64);
    }
    writeFileSync(join(workDir, "manifest-body.json"), JSON.stringify({ manifest }));
    writeFileSync(join(workDir, "index.json"), JSON.stringify(index));
    process.stdout.write(`${files.length}\n`);
    break;
  }
  case "check": {
    const [file, label] = args;
    const body = readJson(file);
    if (body.success !== true) {
      const errs = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
      fail(`${label} failed${errs ? ` (${errs})` : ""}`);
    }
    break;
  }
  case "get": {
    const [file, path] = args;
    let v = readJson(file);
    for (const part of path.split(".")) v = v?.[part];
    if (v === undefined || v === null) process.exit(2);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    break;
  }
  case "buckets": {
    // One line per bucket: "hash|mime hash|mime ..."
    const [file, workDir] = args;
    const body = readJson(file);
    const index = JSON.parse(readFileSync(join(workDir, "index.json"), "utf8"));
    for (const bucket of body.result?.buckets ?? []) {
      const parts = bucket.map((h) => {
        if (!index[h]) fail(`server asked for unknown hash ${h}`);
        return `${h}|${index[h].type}`;
      });
      if (parts.length) process.stdout.write(`${parts.join(" ")}\n`);
    }
    break;
  }
  case "metadata": {
    const [jwt, compat, out] = args;
    if (!jwt || !compat || !out) fail("usage: metadata <jwt> <compatDate> <out.json>");
    const meta = {
      main_module: "worker.js",
      compatibility_date: compat,
      bindings: [{ type: "assets", name: "ASSETS" }],
      assets: {
        jwt,
        config: { html_handling: "auto-trailing-slash", not_found_handling: "single-page-application" },
      },
    };
    writeFileSync(out, JSON.stringify(meta));
    break;
  }
  default:
    fail("unknown command");
}
