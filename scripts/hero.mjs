// Make the README hero from the viewer's own Record button:
//   1. open the demo in Chromium, set 4x speed and press Record (full replay + hotspot tour)
//   2. play the downloaded WebM back in the browser and grab frames
//   3. assemble them into docs/media/hero.gif with ImageMagick
// Usage: node scripts/hero.mjs [baseUrl]   (serve the built viewer first, e.g. npx vite preview packages/viewer)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:4180/";
const out = new URL("../docs/media/", import.meta.url);
const work = mkdtempSync(join(tmpdir(), "gc-hero-"));
const FPS = 8;
const SECONDS = 11;
const WIDTH = 760;

const browser = await chromium.launch({
  args: [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  await page.goto(base);
  await page.waitForFunction(() => window.__gc?.ready === true, undefined, { timeout: 60_000 });
  await page.selectOption('select[aria-label="Playback speed"]', "4");
  await page.dispatchEvent('select[aria-label="Playback speed"]', "change");
  const download = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("button", { name: "Record" }).click();
  const file = await download;
  const webm = join(work, file.suggestedFilename());
  await file.saveAs(webm);
  mkdirSync(out, { recursive: true });
  writeFileSync(new URL(file.suggestedFilename(), out), readFileSync(webm));
  console.log(`recorded ${file.suggestedFilename()} (${(readFileSync(webm).length / 1e6).toFixed(1)} MB)`);

  // Decode the recording in the page and sample frames.
  const player = await browser.newPage({ viewport: { width: WIDTH, height: 600 } });
  await player.setContent("<video muted playsinline></video><canvas></canvas>");
  const b64 = readFileSync(webm).toString("base64");
  const frames = await player.evaluate(
    async ({ b64, fps, seconds, width }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const video = document.querySelector("video");
      video.src = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
      await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
      // MediaRecorder WebM files often report an infinite duration until seeked far ahead.
      if (!Number.isFinite(video.duration)) {
        video.currentTime = 1e9;
        await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
      }
      const h = Math.round((video.videoHeight / video.videoWidth) * width);
      const canvas = document.querySelector("canvas");
      canvas.width = width;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      const out = [];
      const total = Math.min(seconds, video.duration || seconds);
      for (let t = 0.3; t < total; t += 1 / fps) {
        video.currentTime = t;
        await new Promise((r) => video.addEventListener("seeked", r, { once: true }));
        ctx.drawImage(video, 0, 0, width, h);
        out.push(canvas.toDataURL("image/png").split(",")[1]);
      }
      return out;
    },
    { b64, fps: FPS, seconds: SECONDS, width: WIDTH },
  );
  frames.forEach((f, i) => {
    writeFileSync(join(work, `f${String(i).padStart(4, "0")}.png`), Buffer.from(f, "base64"));
  });
  const gif = fileURLToPath(new URL("hero.gif", out));
  const pngs = frames.map((_, i) => join(work, `f${String(i).padStart(4, "0")}.png`));
  execFileSync("convert", [
    "-delay",
    String(Math.round(100 / FPS)),
    "-loop",
    "0",
    ...pngs,
    "-colors",
    "160",
    "-layers",
    "Optimize",
    gif,
  ]);
  console.log(`hero.gif: ${frames.length} frames, ${(readFileSync(gif).length / 1e6).toFixed(1)} MB`);
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
