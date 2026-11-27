// npm pack must ship the bundled viewer; it is copied in by the root build.
import { existsSync } from "node:fs";

if (
  !existsSync(new URL("./dist/main.js", import.meta.url)) ||
  !existsSync(new URL("./dist/viewer/index.html", import.meta.url))
) {
  process.stderr.write("git-cinematic: dist is incomplete; run `npm run build` at the repository root first\n");
  process.exit(1);
}
