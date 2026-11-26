// Bundle the CLI and the core library into one dependency-free ES module.
import { chmodSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync("dist/main.js", 0o755);
