import type { City, CityDir } from "@git-cinematic/core/format";
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Points,
  ShaderMaterial,
} from "three";
import { mulberry32 } from "./world.js";
import {
  beaconFragment,
  beaconVertex,
  carFragment,
  carVertex,
  emberFragment,
  emberVertex,
  lampFragment,
  lampVertex,
  pointScale,
} from "./worldShaders.js";

/** Street width per side for each directory depth; mirrors STREETS in core/src/layout.ts. */
const STREETS = [0, 4, 2, 1, 0.5];
const PLATE_HEIGHT = 0.6;

export const MAX_CARS = 3500;
export const MAX_LAMPS = 5000;
export const MAX_BEACONS = 400;
export const EMBER_FILES = 600;
export const EMBERS_PER_FILE = 10;

export function streetMargin(dir: Pick<CityDir, "w" | "d" | "depth">): number {
  const m = STREETS[Math.min(dir.depth, 4)] ?? 0;
  return Math.min(m, dir.w / 4, dir.d / 4);
}

export function plateTop(depth: number): number {
  return (depth - 1) * PLATE_HEIGHT * 0.5 + PLATE_HEIGHT * 0.5;
}

export interface Lane {
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
}

/** One clockwise lane loop inside the street ring of every district and neighbourhood. */
export function laneLoops(dirs: readonly CityDir[]): Lane[] {
  const lanes: Lane[] = [];
  for (const d of dirs) {
    if (d.depth > 2) continue;
    const m = streetMargin(d);
    if (m < 0.8) continue;
    const off = m * 0.42;
    const w = d.w - 2 * off;
    const dd = d.d - 2 * off;
    if (w < 6 || dd < 6) continue;
    lanes.push({ x: d.x - d.w / 2 + off, z: d.z - d.d / 2 + off, w, d: dd, y: plateTop(d.depth) + 0.02 });
  }
  return lanes;
}

interface Shared {
  uHistory: { value: unknown };
  uTime: { value: number };
  uBuckets: { value: number };
  uClock: { value: number };
  uFlicker: { value: number };
  uFogColor: { value: unknown };
  uFogDensity: { value: number };
}

/** Roads, traffic and lights for one city. Uniforms are shared with the building material. */
export function buildStreets(city: City, shared: Shared, finalHeights: Float32Array): Group {
  const group = new Group();
  group.name = "streets";
  const rand = mulberry32(0x5eed);
  group.add(markings(city.dirs));

  // ---- traffic ----
  const lanes = laneLoops(city.dirs);
  const cars: number[] = [];
  const loops: number[] = [];
  for (const lane of lanes) {
    const P = 2 * (lane.w + lane.d);
    const n = Math.max(1, Math.floor(P / (lane.y < 0.5 ? 38 : 70)));
    for (let k = 0; k < n && cars.length / 4 < MAX_CARS; k++) {
      loops.push(lane.x, lane.z, lane.w, lane.d);
      cars.push((k + rand() * 0.6) / n, 7 + rand() * 9, lane.y, rand());
    }
  }
  if (cars.length) {
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    box.setAttribute("aLoop", new InstancedBufferAttribute(new Float32Array(loops), 4));
    box.setAttribute("aCar", new InstancedBufferAttribute(new Float32Array(cars), 4));
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: carVertex,
      fragmentShader: carFragment,
      uniforms: { uClock: shared.uClock, uFogColor: shared.uFogColor, uFogDensity: shared.uFogDensity },
    });
    const mesh = new InstancedMesh(box, mat, cars.length / 4);
    mesh.frustumCulled = false;
    mesh.name = "traffic";
    group.add(mesh);
  }

  // ---- street lamps along the kerbs of the districts ----
  const lampPos: number[] = [];
  const lampSeed: number[] = [];
  for (const d of city.dirs) {
    if (d.depth > 2 || lampPos.length / 3 >= MAX_LAMPS) continue;
    const m = streetMargin(d);
    if (m < 0.8) continue;
    const inset = m * 0.92;
    const x0 = d.x - d.w / 2 + inset;
    const x1 = d.x + d.w / 2 - inset;
    const z0 = d.z - d.d / 2 + inset;
    const z1 = d.z + d.d / 2 - inset;
    const step = d.depth === 1 ? 22 : 34;
    const y = plateTop(d.depth) + 3.2;
    const edge = (ax: number, az: number, bx: number, bz: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.floor(len / step);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        lampPos.push(ax + (bx - ax) * t, y, az + (bz - az) * t);
        lampSeed.push(rand());
      }
    };
    edge(x0, z0, x1, z0);
    edge(x1, z0, x1, z1);
    edge(x1, z1, x0, z1);
    edge(x0, z1, x0, z0);
  }
  if (lampPos.length) {
    group.add(
      glowPoints("lamps", { position: [lampPos, 3], aSeed: [lampSeed, 1] }, lampVertex, lampFragment, {
        uPointScale: pointScale,
        uFogColor: shared.uFogColor,
        uFogDensity: shared.uFogDensity,
      }),
    );
  }

  // ---- aviation beacons on the tallest towers ----
  const byHeight = city.files.map((_, i) => i).sort((a, b) => (finalHeights[b] ?? 0) - (finalHeights[a] ?? 0));
  const towers = byHeight.slice(0, Math.min(MAX_BEACONS, Math.ceil(city.files.length * 0.06)));
  const minTower = finalHeights[towers[towers.length - 1] ?? -1] ?? 0;
  if (towers.length && minTower > 0) {
    const pos: number[] = [];
    const file: number[] = [];
    const seed: number[] = [];
    for (const i of towers) {
      const f = city.files[i];
      if (!f) continue;
      pos.push(f.x, 0, f.z);
      file.push(i);
      seed.push(rand());
    }
    group.add(
      glowPoints("beacons", { position: [pos, 3], aFile: [file, 1], aSeed: [seed, 1] }, beaconVertex, beaconFragment, {
        ...historyUniforms(shared),
        uPointScale: pointScale,
        uClock: shared.uClock,
        uFogColor: shared.uFogColor,
        uFogDensity: shared.uFogDensity,
        uBeaconMin: { value: Math.max(40, minTower * 0.85) },
      }),
    );
  }

  // ---- embers rising from files on fire ----
  const hot = city.files
    .map((f, i) => [i, f.fixes] as const)
    .filter(([, fixes]) => fixes > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, EMBER_FILES);
  if (hot.length) {
    const pos: number[] = [];
    const file: number[] = [];
    const foot: number[] = [];
    const seed: number[] = [];
    for (const [i] of hot) {
      const f = city.files[i];
      if (!f) continue;
      for (let k = 0; k < EMBERS_PER_FILE; k++) {
        pos.push(f.x, 0, f.z);
        file.push(i);
        foot.push(f.x, f.z, f.w, f.d);
        seed.push(rand(), rand());
      }
    }
    group.add(
      glowPoints(
        "embers",
        { position: [pos, 3], aFile: [file, 1], aFoot: [foot, 4], aSeed: [seed, 2] },
        emberVertex,
        emberFragment,
        { ...historyUniforms(shared), uPointScale: pointScale, uClock: shared.uClock, uFlicker: shared.uFlicker },
      ),
    );
  }
  return group;
}

function historyUniforms(shared: Shared) {
  return { uHistory: shared.uHistory, uTime: shared.uTime, uBuckets: shared.uBuckets };
}

function glowPoints(
  name: string,
  attrs: Record<string, [number[], number]>,
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, { value: unknown }>,
): Points {
  const geo = new BufferGeometry();
  for (const [key, [values, size]] of Object.entries(attrs)) {
    geo.setAttribute(key, new BufferAttribute(new Float32Array(values), size));
  }
  const mat = new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  points.name = name;
  return points;
}

/** Dashed centre lines: amber on the boulevards between districts, white in the side streets. */
function markings(dirs: readonly CityDir[]): Group {
  const g = new Group();
  const byKind: [number[], number[], number[]] = [[], [], []];
  for (const d of dirs) {
    const kind = d.depth === 1 ? 0 : d.depth === 2 ? 1 : 2;
    const top = plateTop(d.depth) + 0.03;
    const x0 = d.x - d.w / 2;
    const x1 = d.x + d.w / 2;
    const z0 = d.z - d.d / 2;
    const z1 = d.z + d.d / 2;
    byKind[kind].push(
      ...[x0, top, z0, x1, top, z0],
      ...[x1, top, z0, x1, top, z1],
      ...[x1, top, z1, x0, top, z1],
      ...[x0, top, z1, x0, top, z0],
    );
  }
  const mats = [
    new LineDashedMaterial({ color: 0xffb347, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.75 }),
    new LineDashedMaterial({ color: 0x9fb4d8, dashSize: 1.6, gapSize: 2.4, transparent: true, opacity: 0.4 }),
    new LineBasicMaterial({ color: 0x2a3f66, transparent: true, opacity: 0.45 }),
  ];
  byKind.forEach((pts, k) => {
    if (!pts.length) return;
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(pts, 3));
    const lines = new LineSegments(geo, mats[k]);
    if (k < 2) lines.computeLineDistances();
    g.add(lines);
  });
  return g;
}

/** Dispose every geometry and material below a group. */
export function disposeTree(root: Group): void {
  root.traverse((o) => {
    const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } | { dispose(): void }[] };
    m.geometry?.dispose();
    if (Array.isArray(m.material)) for (const x of m.material) x.dispose();
    else m.material?.dispose();
  });
}
