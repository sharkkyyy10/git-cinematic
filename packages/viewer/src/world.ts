import {
  BackSide,
  BoxGeometry,
  type Color,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
} from "three";
import {
  groundFragment,
  groundVertex,
  OUTSKIRT_PITCH,
  OUTSKIRT_ROAD,
  outskirtFragment,
  outskirtVertex,
  skyFragment,
  skyVertex,
} from "./worldShaders.js";

/** Half-size of the square the real city occupies, plus a ring road around it. */
const CITY_CLEAR = 560;
const OUTSKIRT_RADIUS = 2300;

/** A small deterministic PRNG so the outskirts look the same on every visit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OutskirtBlock {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  seed: number;
}

/** Procedural filler blocks on a road grid around the city, taller towards downtown. */
export function outskirtBlocks(seed = 7): OutskirtBlock[] {
  const rand = mulberry32(seed);
  const out: OutskirtBlock[] = [];
  const pitch = OUTSKIRT_PITCH;
  const lot = pitch - OUTSKIRT_ROAD - 3;
  const n = Math.ceil(OUTSKIRT_RADIUS / pitch);
  for (let i = -n; i < n; i++) {
    for (let j = -n; j < n; j++) {
      const cx = (i + 0.5) * pitch;
      const cz = (j + 0.5) * pitch;
      const r = Math.hypot(cx, cz);
      if (r > OUTSKIRT_RADIUS) continue;
      if (Math.abs(cx) < CITY_CLEAR + pitch / 2 && Math.abs(cz) < CITY_CLEAR + pitch / 2) continue;
      if (rand() < 0.12) continue; // parks and empty lots
      const near = Math.max(0, 1 - (r - CITY_CLEAR) / (OUTSKIRT_RADIUS - CITY_CLEAR));
      const split = rand() < 0.45;
      const parts = split ? 2 : 1;
      for (let k = 0; k < parts; k++) {
        const w = split ? lot / 2 - 1.5 : lot * (0.7 + 0.3 * rand());
        const d = lot * (0.6 + 0.4 * rand());
        const ox = split ? (k === 0 ? -lot / 4 : lot / 4) : 0;
        const tall = rand() ** 3;
        out.push({
          x: cx + ox,
          z: cz + (rand() - 0.5) * (lot - d),
          w,
          d,
          h: 5 + tall * (25 + 110 * near * near) + rand() * 6,
          seed: rand() * 1000,
        });
      }
    }
  }
  return out;
}

export interface World {
  group: Group;
  sky: Mesh;
  uniforms: { uClock: { value: number } };
}

export function createWorld(fogColor: Color, fogDensity: number): World {
  const group = new Group();
  const uClock = { value: 0 };
  const uFogColor = { value: fogColor };
  const uFogDensity = { value: fogDensity };

  const sky = new Mesh(
    new SphereGeometry(9000, 48, 24),
    new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: { uClock, uHorizon: uFogColor },
      side: BackSide,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  group.add(sky);

  const ground = new Mesh(
    new PlaneGeometry(12000, 12000),
    new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: groundVertex,
      fragmentShader: groundFragment,
      uniforms: { uClock, uFogColor, uFogDensity },
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.7;
  group.add(ground);

  const blocks = outskirtBlocks();
  const box = new BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const aBox = new Float32Array(blocks.length * 4);
  const aShape = new Float32Array(blocks.length * 2);
  blocks.forEach((b, i) => {
    aBox.set([b.x, b.z, b.w, b.d], i * 4);
    aShape.set([b.h, b.seed], i * 2);
  });
  box.setAttribute("aBox", new InstancedBufferAttribute(aBox, 4));
  box.setAttribute("aShape", new InstancedBufferAttribute(aShape, 2));
  const outskirts = new InstancedMesh(
    box,
    new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: outskirtVertex,
      fragmentShader: outskirtFragment,
      uniforms: { uClock, uFogColor, uFogDensity },
    }),
    blocks.length,
  );
  outskirts.frustumCulled = false;
  group.add(outskirts);

  return { group, sky, uniforms: { uClock } };
}
