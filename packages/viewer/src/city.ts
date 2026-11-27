import { type City, FILE_DELETED } from "@git-cinematic/core/format";
import {
  BoxGeometry,
  Color,
  DataTexture,
  GLSL3,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  NearestFilter,
  RGIntegerFormat,
  ShaderMaterial,
  UnsignedShortType,
} from "three";
import { buildingFragment, buildingVertex, HISTORY_WIDTH } from "./shaders.js";
import { buildStreets, disposeTree } from "./streets.js";

export const PLATE_HEIGHT = 0.6;

export function heightForLoc(loc: number): number {
  return loc < 0.5 ? 0 : 2 + 14 * Math.log2(1 + loc);
}

/** The rendered city: one instanced mesh for every building plus the district plates. */
export class CityView {
  readonly group = new Group();
  readonly buildings: InstancedMesh;
  readonly material: ShaderMaterial;
  readonly buckets: number;
  private readonly texture: DataTexture;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    readonly city: City,
    fogColor: Color,
    fogDensity: number,
  ) {
    const F = city.files.length;
    const B = Math.max(1, city.bucketStart.length);
    this.buckets = B;

    const texels = Math.max(1, F * B);
    const rows = Math.ceil(texels / HISTORY_WIDTH);
    const data = new Uint16Array(HISTORY_WIDTH * rows * 2);
    data.set(city.history.subarray(0, Math.min(city.history.length, data.length)));
    this.texture = new DataTexture(data, HISTORY_WIDTH, rows, RGIntegerFormat, UnsignedShortType);
    this.texture.internalFormat = "RG16UI";
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const footprint = new Float32Array(F * 4);
    const fileIndex = new Float32Array(F);
    const stat = new Float32Array(F * 2);
    city.files.forEach((f, i) => {
      footprint.set([f.x, f.z, f.w, f.d], i * 4);
      fileIndex[i] = i;
      stat[i * 2] = f.centrality;
      stat[i * 2 + 1] = f.authors;
    });
    box.setAttribute("aFootprint", new InstancedBufferAttribute(footprint, 4));
    box.setAttribute("aFile", new InstancedBufferAttribute(fileIndex, 1));
    box.setAttribute("aStatic", new InstancedBufferAttribute(stat, 2));
    this.lensValues = new InstancedBufferAttribute(new Float32Array(Math.max(F, 1)), 1);
    box.setAttribute("aLens", this.lensValues);

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: buildingVertex,
      fragmentShader: buildingFragment,
      uniforms: {
        uHistory: { value: this.texture },
        uTime: { value: B - 1 },
        uBuckets: { value: B },
        uSelected: { value: -1 },
        uHovered: { value: -1 },
        uClock: { value: 0 },
        uFlicker: { value: 1 },
        uLens: { value: 0 },
        uLensMode: { value: 0 },
        uFogColor: { value: fogColor },
        uFogDensity: { value: fogDensity },
      },
    });
    this.buildings = new InstancedMesh(box, this.material, Math.max(F, 1));
    this.buildings.count = F;
    // Positions come from the shader, so the CPU-side bounds are meaningless.
    this.buildings.frustumCulled = false;
    this.group.add(this.buildings);
    this.disposables.push(box, this.material, this.texture);
    this.addPlates();

    const last = B - 1;
    const finalHeights = new Float32Array(F);
    for (let i = 0; i < F; i++) finalHeights[i] = heightForLoc(city.history[(i * B + last) * 2] ?? 0);
    const u = this.material.uniforms as unknown as Parameters<typeof buildStreets>[1];
    this.streets = buildStreets(city, u, finalHeights);
    this.group.add(this.streets);
  }

  /** Roads, traffic, lamps, beacons and embers. */
  readonly streets: Group;
  /** Per-building value for the active lens or highlight, 0..1. */
  private readonly lensValues: InstancedBufferAttribute;

  /**
   * Recolour the city: "ramp" maps each value through the lens colour ramp, "mask" lights up the
   * buildings with a value of 1 and dims the rest, and null returns to the cinematic look.
   */
  setLens(values: ArrayLike<number> | null, mode: "ramp" | "mask" = "ramp"): void {
    const u = this.material.uniforms as Record<string, { value: number }>;
    if (!values) {
      (u.uLens as { value: number }).value = 0;
      return;
    }
    const arr = this.lensValues.array as Float32Array;
    for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, Math.max(0, values[i] ?? 0));
    this.lensValues.needsUpdate = true;
    (u.uLens as { value: number }).value = 1;
    (u.uLensMode as { value: number }).value = mode === "mask" ? 1 : 0;
  }

  private addPlates(): void {
    const dirs = this.city.dirs;
    if (dirs.length === 0) return;
    const geo = new BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new MeshLambertMaterial({ color: 0xffffff });
    const plates = new InstancedMesh(geo, mat, dirs.length);
    const m = new Matrix4();
    const c = new Color();
    dirs.forEach((d, i) => {
      const y = (d.depth - 1) * PLATE_HEIGHT * 0.5;
      m.makeScale(d.w, PLATE_HEIGHT, d.d).setPosition(d.x, y - PLATE_HEIGHT * 0.5, d.z);
      plates.setMatrixAt(i, m);
      // Asphalt for the districts, lighter pavement and plazas for the blocks inside them.
      if (d.depth === 1) c.setHSL(0.62, 0.18, 0.028);
      else c.setHSL(0.6, 0.14, 0.045 + Math.min(d.depth, 5) * 0.012);
      plates.setColorAt(i, c);
    });
    plates.instanceMatrix.needsUpdate = true;
    if (plates.instanceColor) plates.instanceColor.needsUpdate = true;
    this.group.add(plates);
    this.disposables.push(geo, mat);
  }

  get time(): number {
    return this.material.uniforms.uTime?.value as number;
  }

  setTime(t: number): void {
    (this.material.uniforms.uTime as { value: number }).value = Math.min(Math.max(t, 0), this.buckets - 1);
  }

  setClock(seconds: number): void {
    (this.material.uniforms.uClock as { value: number }).value = seconds;
  }

  setFlicker(on: boolean): void {
    (this.material.uniforms.uFlicker as { value: number }).value = on ? 1 : 0;
  }

  setSelected(index: number): void {
    (this.material.uniforms.uSelected as { value: number }).value = index;
  }

  setHovered(index: number): void {
    (this.material.uniforms.uHovered as { value: number }).value = index;
  }

  private sample(file: number, t: number, channel: 0 | 1): number {
    const B = this.buckets;
    const tt = Math.min(Math.max(t, 0), B - 1);
    const b0 = Math.floor(tt);
    const b1 = Math.min(b0 + 1, B - 1);
    const f = tt - b0;
    const h = this.city.history;
    const a = h[(file * B + b0) * 2 + channel] ?? 0;
    const b = h[(file * B + b1) * 2 + channel] ?? 0;
    return a + (b - a) * f;
  }

  /** Lines of code for a file at time t (interpolated like the shader). */
  locAt(file: number, t = this.time): number {
    return this.sample(file, t, 0);
  }

  heatAt(file: number, t = this.time): number {
    return this.sample(file, t, 1) / 65535;
  }

  heightAt(file: number, t = this.time): number {
    return heightForLoc(this.locAt(file, t));
  }

  /** Index of a standing building that is not deleted, preferring the tallest. */
  tallest(t = this.time): number {
    let best = -1;
    let bestH = 0;
    this.city.files.forEach((f, i) => {
      if (f.flags & FILE_DELETED) return;
      const h = this.heightAt(i, t);
      if (h > bestH) {
        bestH = h;
        best = i;
      }
    });
    return best;
  }

  dispose(): void {
    disposeTree(this.streets);
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
