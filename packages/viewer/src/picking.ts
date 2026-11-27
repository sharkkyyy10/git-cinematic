import { type PerspectiveCamera, Raycaster, Vector2 } from "three";
import type { CityView } from "./city.js";

const raycaster = new Raycaster();
const ndc = new Vector2();

/** Slab test of a ray against an axis-aligned box. Returns the entry distance or Infinity. */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  min: [number, number, number],
  max: [number, number, number],
): number {
  let tmin = Number.NEGATIVE_INFINITY;
  let tmax = Number.POSITIVE_INFINITY;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    const oa = o[a] as number;
    const da = d[a] as number;
    const lo = min[a] as number;
    const hi = max[a] as number;
    if (Math.abs(da) < 1e-12) {
      if (oa < lo || oa > hi) return Number.POSITIVE_INFINITY;
      continue;
    }
    let t1 = (lo - oa) / da;
    let t2 = (hi - oa) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Number.POSITIVE_INFINITY;
  }
  if (tmax < 0) return Number.POSITIVE_INFINITY;
  return tmin >= 0 ? tmin : tmax;
}

/** The nearest standing building under a canvas-relative pointer position, or -1. */
export function pickBuilding(
  view: CityView,
  camera: PerspectiveCamera,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const { origin, direction } = raycaster.ray;
  let best = -1;
  let bestT = Number.POSITIVE_INFINITY;
  const files = view.city.files;
  for (let i = 0; i < files.length; i++) {
    const h = view.heightAt(i);
    if (h <= 0) continue;
    const f = files[i];
    if (!f) continue;
    const t = rayBox(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      [f.x - f.w / 2, 0, f.z - f.d / 2],
      [f.x + f.w / 2, h, f.z + f.d / 2],
    );
    if (t < bestT) {
      bestT = t;
      best = i;
    }
  }
  return best;
}
