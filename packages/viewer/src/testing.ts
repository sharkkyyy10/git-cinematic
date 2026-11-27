import { Vector3 } from "three";
import type { App } from "./app.js";

/** Deterministic hooks used by the end-to-end tests: freeze the loop, render and read pixels. */
export interface TestHooks {
  ready: boolean;
  freeze(): void;
  setTime(t: number): void;
  /** Fraction of pixels that differ from the background after rendering one frame. */
  coverage(): number;
  /** A cheap fingerprint of the rendered frame. */
  fingerprint(): number;
  /** Viewport point on a visible building, with its index, or null. */
  buildingPoint(): { x: number; y: number; index: number } | null;
}

function readFrame(app: App): Uint8Array {
  app.renderNow();
  const gl = app.stage.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

export function installTestHooks(app: App): TestHooks {
  const hooks: TestHooks = {
    ready: false,
    freeze() {
      app.frozen = true;
    },
    setTime(t) {
      app.timeline?.pause();
      app.timeline?.setTime(t);
    },
    coverage() {
      const px = readFrame(app);
      let differ = 0;
      const n = px.length / 4;
      for (let i = 0; i < px.length; i += 4) {
        const d =
          Math.abs((px[i] as number) - 4) + Math.abs((px[i + 1] as number) - 6) + Math.abs((px[i + 2] as number) - 12);
        if (d > 18) differ++;
      }
      return differ / n;
    },
    fingerprint() {
      const px = readFrame(app);
      let h = 2166136261;
      for (let i = 0; i < px.length; i += 7) h = Math.imul(h ^ (px[i] as number), 16777619);
      return h >>> 0;
    },
    buildingPoint() {
      const view = app.view;
      if (!view) return null;
      const rect = app.shell.canvas.getBoundingClientRect();
      const order = view.city.files.map((_, i) => i).sort((a, b) => view.heightAt(b) - view.heightAt(a));
      for (const index of order.slice(0, 60)) {
        const f = view.city.files[index];
        const h = view.heightAt(index);
        if (!f || h <= 0) continue;
        const p = app.stage.project(new Vector3(f.x, h * 0.8, f.z));
        const x = p.x - rect.left;
        const y = p.y - rect.top;
        if (x < 40 || y < 80 || x > rect.width - 40 || y > rect.height - 120) continue;
        if (app.pickAt(x, y) === index) return { x: p.x, y: p.y, index };
      }
      return null;
    },
  };
  (window as unknown as { __gc: TestHooks }).__gc = hooks;
  return hooks;
}
