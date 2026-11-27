// Writes the demo city: node packages/core/dist/demo-cli.js <out.bin>
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildDemoCity } from "./demo.js";
import { FILE_DELETED } from "./format.js";
import { packCity } from "./gzip.js";

const out = process.argv[2];
if (!out) {
  process.stderr.write("usage: demo-cli <out.bin>\n");
  process.exit(2);
}
const city = buildDemoCity();
const bytes = packCity(city);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
const deleted = city.files.filter((f) => f.flags & FILE_DELETED).length;
process.stdout.write(
  `demo city: ${city.files.length} files (${deleted} deleted), ${city.dirs.length} dirs, ${city.bucketStart.length} buckets, ${city.eras.length} eras, ${bytes.length} bytes → ${out}\n`,
);
for (const e of city.eras) process.stdout.write(`  ${e.startBucket}-${e.endBucket}  ${e.title}\n`);
