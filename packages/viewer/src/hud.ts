import type { City } from "@git-cinematic/core/format";
import { Vector3 } from "three";
import type { App } from "./app.js";
import { el } from "./ui.js";

const MAP_PX = 176;
const MAP_EXTENT = 620; // world units drawn into the cached map, each side of the centre
const MAP_CACHE = 768;
const LABELS_TOP = 12;
const LABELS_NEIGHBOURHOOD = 28;

/** Map transform for a camera heading: world (x, z) to minimap pixels. */
export interface MapFrame {
  cx: number;
  cy: number;
  scale: number;
  tx: number;
  tz: number;
  fx: number;
  fz: number;
}

export function worldToMap(m: MapFrame, x: number, z: number): [number, number] {
  const dx = x - m.tx;
  const dz = z - m.tz;
  const rx = -m.fz;
  const rz = m.fx;
  return [m.cx + (dx * rx + dz * rz) * m.scale, m.cy - (dx * m.fx + dz * m.fz) * m.scale];
}

export function mapToWorld(m: MapFrame, px: number, py: number): [number, number] {
  const sx = (px - m.cx) / m.scale;
  const sy = -(py - m.cy) / m.scale;
  // Screen right is r = (-fz, fx), screen up is f.
  return [m.tx + -m.fz * sx + m.fx * sy, m.tz + m.fx * sx + m.fz * sy];
}

function renderMapCache(city: City): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = MAP_CACHE;
  c.height = MAP_CACHE;
  const g = c.getContext("2d");
  if (!g) return c;
  const k = MAP_CACHE / (2 * MAP_EXTENT);
  const X = (x: number) => (x + MAP_EXTENT) * k;
  g.fillStyle = "#07090f";
  g.fillRect(0, 0, MAP_CACHE, MAP_CACHE);
  // Outskirt road grid, faint.
  g.strokeStyle = "rgba(255,150,70,0.10)";
  g.lineWidth = 1;
  for (let v = -MAP_EXTENT; v <= MAP_EXTENT; v += 48) {
    g.beginPath();
    g.moveTo(X(v), 0);
    g.lineTo(X(v), MAP_CACHE);
    g.moveTo(0, X(v));
    g.lineTo(MAP_CACHE, X(v));
    g.stroke();
  }
  for (const d of city.dirs) {
    const shade = d.depth === 1 ? "#141a2a" : d.depth === 2 ? "#1d2538" : "#253049";
    g.fillStyle = shade;
    const inset = d.depth === 1 ? 1.2 : 0.6;
    g.fillRect(X(d.x - d.w / 2) + inset, X(d.z - d.d / 2) + inset, d.w * k - 2 * inset, d.d * k - 2 * inset);
  }
  g.fillStyle = "#3a4867";
  for (const f of city.files)
    g.fillRect(X(f.x - f.w / 2), X(f.z - f.d / 2), Math.max(1, f.w * k), Math.max(1, f.d * k));
  return c;
}

/** Install the minimap, compass and district labels. */
export function installHud(app: App): void {
  const s = app.shell;
  const canvas = el("canvas", { class: "minimap-canvas", "aria-hidden": "true" });
  const north = el("span", { class: "compass-n", text: "N" });
  const minimap = el("div", { class: "minimap", title: "Minimap: click to travel there" }, [canvas, north]);
  const labels = el("div", { class: "labels", "aria-hidden": "true" });
  const keys = el("div", { class: "keys", "aria-hidden": "true" }, [
    el("kbd", { text: "W A S D" }),
    el("span", { text: "fly" }),
    el("kbd", { text: "Q E" }),
    el("span", { text: "turn" }),
    el("kbd", { text: "Shift" }),
    el("span", { text: "boost" }),
  ]);
  s.root.insertBefore(labels, s.tooltip);
  s.root.append(minimap, keys);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = MAP_PX * dpr;
  canvas.height = MAP_PX * dpr;
  const ctx = canvas.getContext("2d");
  let cache: HTMLCanvasElement | null = null;
  let frame: MapFrame | null = null;
  let since = 1;
  let tags: { node: HTMLElement; pos: Vector3; depth: number }[] = [];

  app.onCity((a) => {
    const city = a.city;
    if (!city) return;
    cache = renderMapCache(city);
    labels.textContent = "";
    const area = (d: { w: number; d: number }) => d.w * d.d;
    const top = city.dirs
      .filter((d) => d.depth === 1)
      .sort((x, y) => area(y) - area(x))
      .slice(0, LABELS_TOP);
    const hoods = city.dirs
      .filter((d) => d.depth === 2)
      .sort((x, y) => area(y) - area(x))
      .slice(0, LABELS_NEIGHBOURHOOD);
    tags = [...top, ...hoods].map((d) => {
      const name = d.path.split("/").pop() ?? d.path;
      const node = el("div", { class: `label depth-${d.depth}`, text: name });
      labels.append(node);
      return { node, pos: new Vector3(d.x, 2, d.z), depth: d.depth };
    });
    since = 1;
  });

  const camDir = new Vector3();
  const p = new Vector3();
  app.frameListeners.push((dt) => {
    updateLabels();
    since += dt;
    if (since < 0.1) return;
    since = 0;
    drawMap();
  });

  function updateLabels(): void {
    const cam = app.stage.camera;
    const target = app.stage.controls.target;
    const dist = cam.position.distanceTo(target);
    const rect = s.canvas.getBoundingClientRect();
    cam.getWorldDirection(camDir);
    for (const t of tags) {
      p.copy(t.pos).project(cam);
      const along = t.pos.clone().sub(cam.position).dot(camDir);
      const fade =
        t.depth === 1
          ? Math.min(1, Math.max(0, (dist - 180) / 220))
          : Math.min(1, Math.max(0, (700 - dist) / 260)) * Math.min(1, Math.max(0, (dist - 60) / 80));
      if (along <= 0 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1 || fade <= 0.01) {
        t.node.style.opacity = "0";
        continue;
      }
      const x = ((p.x + 1) / 2) * rect.width;
      const y = ((1 - p.y) / 2) * rect.height;
      t.node.style.opacity = String(fade);
      t.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    }
  }

  function drawMap(): void {
    if (!ctx || !cache || !app.view || !app.city) return;
    const cam = app.stage.camera.position;
    const target = app.stage.controls.target;
    let fx = target.x - cam.x;
    let fz = target.z - cam.z;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len;
    fz /= len;
    const dist = cam.distanceTo(target);
    const radius = Math.min(900, Math.max(120, dist * 0.75));
    const half = MAP_PX / 2;
    const m: MapFrame = { cx: half, cy: half, scale: half / radius, tx: target.x, tz: target.z, fx, fz };
    frame = m;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MAP_PX, MAP_PX);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#050609";
    ctx.fillRect(0, 0, MAP_PX, MAP_PX);
    const rx = -fz;
    const rz = fx;
    const sc = m.scale;
    ctx.setTransform(
      dpr * rx * sc,
      dpr * -fx * sc,
      dpr * rz * sc,
      dpr * -fz * sc,
      dpr * (half - sc * (rx * m.tx + rz * m.tz)),
      dpr * (half + sc * (fx * m.tx + fz * m.tz)),
    );
    ctx.drawImage(cache, -MAP_EXTENT, -MAP_EXTENT, 2 * MAP_EXTENT, 2 * MAP_EXTENT);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Files on fire right now, and the selected file.
    const view = app.view;
    const files = app.city.files;
    for (let i = 0; i < files.length; i++) {
      const heat = view.heatAt(i);
      if (heat < 0.25 || view.locAt(i) < 0.5) continue;
      const f = files[i];
      if (!f) continue;
      const [x, y] = worldToMap(m, f.x, f.z);
      if (Math.hypot(x - half, y - half) > half) continue;
      ctx.fillStyle = `rgba(255, ${Math.round(160 - 120 * heat)}, 40, ${0.45 + 0.55 * heat})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + 2.5 * heat, 0, Math.PI * 2);
      ctx.fill();
    }
    const sel = app.selected >= 0 ? files[app.selected] : undefined;
    if (sel) {
      const [x, y] = worldToMap(m, sel.x, sel.z);
      ctx.strokeStyle = "#6ea8ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // View cone and the player arrow.
    const cone = ctx.createRadialGradient(half, half, 0, half, half, half);
    cone.addColorStop(0, "rgba(110,168,255,0.28)");
    cone.addColorStop(1, "rgba(110,168,255,0)");
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(half, half);
    ctx.arc(half, half, half, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(half, half - 7);
    ctx.lineTo(half + 5, half + 5);
    ctx.lineTo(half, half + 2);
    ctx.lineTo(half - 5, half + 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Compass: north is -z in world space.
    const [nx, ny] = worldToMap(m, m.tx, m.tz - radius);
    const ang = Math.atan2(ny - half, nx - half);
    north.style.transform = `translate(${Math.round(half + Math.cos(ang) * (half - 2))}px, ${Math.round(half + Math.sin(ang) * (half - 2))}px) translate(-50%, -50%)`;
  }

  canvas.addEventListener("click", (e) => {
    if (!frame) return;
    const r = canvas.getBoundingClientRect();
    const [wx, wz] = mapToWorld(frame, e.clientX - r.left, e.clientY - r.top);
    const target = app.stage.controls.target;
    const delta = new Vector3(wx - target.x, 0, wz - target.z);
    void app.moveCamera(
      app.stage.camera.position.clone().add(delta),
      target.clone().add(delta),
      app.reducedMotion ? 1 : 900,
    );
  });
}
