import { type City, FILE_BINARY, FILE_DELETED, hotspots } from "@git-cinematic/core/format";
import { type Finding, fileSignals, findings, type Signals } from "@git-cinematic/core/insights";
import { Vector3 } from "three";
import { CityView } from "./city.js";
import { LoadError, loadCityFile, type Source } from "./load.js";
import { pickBuilding } from "./picking.js";
import { BACKGROUND, FOG_DENSITY, type Stage } from "./scene.js";
import { Timeline } from "./timeline.js";
import { el, fmtDate, fmtInt, type Shell, setStats, showError } from "./ui.js";

const FLAG_NAMES: Record<Finding["id"], string> = {
  hotspots: "Hotspot",
  fire: "On fire now",
  bugs: "Bug-prone",
  silos: "Knowledge silo",
  coupling: "Change magnet",
  dormant: "Dormant giant",
  solo: "Single author",
};

const FLY_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

interface CameraMove {
  fromPos: Vector3;
  toPos: Vector3;
  fromTarget: Vector3;
  toTarget: Vector3;
  start: number;
  duration: number;
  resolve: () => void;
}

export type CityListener = (app: App) => void;

export class App {
  view: CityView | null = null;
  timeline: Timeline | null = null;
  city: City | null = null;
  /** Hotspot rank per file (1-based), 0 when the file has no score. */
  hotspotRank = new Uint32Array(0);
  hotspotOrder: number[] = [];
  /** Lens values and last-change buckets for the current city. */
  signals: Signals | null = null;
  /** Plain-language findings for the current city, most severe first. */
  found: Finding[] = [];
  selected = -1;
  frozen = false;
  readonly reducedMotion: boolean;
  private hovered = -1;
  private pointer: { x: number; y: number } | null = null;
  private pointerDirty = false;
  private downAt: { x: number; y: number } | null = null;
  private move: CameraMove | null = null;
  private last = performance.now();
  private clock = 0;
  private readonly cityListeners: CityListener[] = [];
  /** Keys held for free-roam flight (WASD to move, Q/E to turn, Shift to go faster). */
  private readonly held = new Set<string>();
  private boost = false;
  /** Called when the user starts flying with the keyboard. */
  readonly flyListeners: (() => void)[] = [];
  readonly frameListeners: ((dt: number, now: number) => void)[] = [];

  constructor(
    readonly shell: Shell,
    readonly stage: Stage,
    public source: Source,
  ) {
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.bindPointer();
    this.bindKeys();
    this.bindPanel();
    this.bindTimeline();
    this.bindOpen();
    new ResizeObserver(() => stage.resize()).observe(shell.canvas);
    requestAnimationFrame(this.loop);
  }

  onCity(fn: CityListener): void {
    this.cityListeners.push(fn);
    if (this.city) fn(this);
  }

  setCity(city: City): void {
    this.view?.dispose();
    this.city = city;
    this.view = new CityView(city, BACKGROUND, FOG_DENSITY);
    this.view.setFlicker(!this.reducedMotion);
    this.stage.scene.add(this.view.group);
    this.timeline = new Timeline(city, this.shell, {
      onTime: (t) => {
        this.view?.setTime(t);
        this.pointerDirty = true;
      },
      onEra: (i) => this.emitEra(i),
      onEnd: () => this.emitEnd(),
    });
    this.view.setTime(this.timeline.time);
    const ranked = hotspots(city.files);
    this.hotspotOrder = ranked.filter((h) => h.score > 0).map((h) => h.index);
    this.hotspotRank = new Uint32Array(city.files.length);
    this.hotspotOrder.forEach((index, r) => {
      this.hotspotRank[index] = r + 1;
    });
    this.signals = fileSignals(city);
    this.found = findings(city, this.signals);
    this.select(-1);
    this.shell.repo.textContent = city.repoName;
    document.title = `Git-Cinematic · ${city.repoName}`;
    this.shell.loading.hidden = true;
    this.shell.error.hidden = true;
    this.stage.home();
    if (!this.reducedMotion) {
      // Swoop in over the outskirts to the establishing shot.
      const cam = this.stage.camera.position;
      const toPos = cam.clone();
      const toTarget = this.stage.controls.target.clone();
      cam.set(-1700, 1250, 2300);
      this.stage.controls.target.set(-200, 0, 300);
      void this.moveCamera(toPos, toTarget, 3800);
    }
    for (const fn of this.cityListeners) fn(this);
  }

  readonly eraListeners: ((index: number) => void)[] = [];
  readonly endListeners: (() => void)[] = [];
  private emitEra(i: number): void {
    for (const fn of this.eraListeners) fn(i);
  }
  private emitEnd(): void {
    for (const fn of this.endListeners) fn();
  }

  fail(e: unknown): void {
    if (e instanceof LoadError) showError(this.shell, e.title, e.detail);
    else showError(this.shell, "Something went wrong", e instanceof Error ? e.message : String(e));
    if (this.city) {
      const close = el("button", { type: "button", class: "primary", text: "Back to the city" });
      close.addEventListener("click", () => {
        this.shell.error.hidden = true;
      });
      this.shell.error.append(close);
      close.focus();
    }
  }

  // ---- selection and panel -------------------------------------------------------------------

  select(index: number): void {
    this.selected = index;
    this.view?.setSelected(index);
    const f = index >= 0 ? this.city?.files[index] : undefined;
    if (!f || !this.view) {
      this.shell.panel.hidden = true;
      return;
    }
    this.shell.panelTitle.textContent = f.path;
    this.shell.panelTitle.title = f.path;
    const rank = this.hotspotRank[index] ?? 0;
    const status = f.flags & FILE_DELETED ? "deleted" : f.flags & FILE_BINARY ? "binary" : "at HEAD";
    setStats(this.shell, [
      ["Lines", `${fmtInt(f.loc)} ${status === "at HEAD" ? "" : `(${status})`}`.trim()],
      ["Lines now", fmtInt(this.view.locAt(index))],
      ["Churn", `${fmtInt(f.churn)} commits`],
      ["Fixes", fmtInt(f.fixes)],
      ["Authors", fmtInt(f.authors)],
      ["Centrality", f.centrality.toFixed(2)],
      ["Hotspot rank", rank ? `#${rank} of ${fmtInt(this.hotspotOrder.length)}` : "—"],
      ["Last changed", this.lastChanged(index)],
      ["Flags", this.flagsFor(index)],
    ]);
    this.shell.panel.hidden = false;
  }

  private lastChanged(index: number): string {
    const b = this.signals?.lastChange[index] ?? -1;
    const start = b >= 0 ? this.city?.bucketStart[b] : undefined;
    return start === undefined ? "—" : fmtDate(start);
  }

  /** The findings that name this file, e.g. "Hotspot · Knowledge silo". */
  flagsFor(index: number): string {
    const names = this.found.filter((f) => f.files.includes(index)).map((f) => FLAG_NAMES[f.id]);
    return names.length ? names.join(" · ") : "none";
  }

  /** Smoothly move the camera to frame a building. */
  flyTo(index: number, duration = 1400): Promise<void> {
    const f = this.city?.files[index];
    if (!f || !this.view) return Promise.resolve();
    const h = Math.max(this.view.heightAt(index), this.view.heightAt(index, this.timeline?.last ?? 0), 4);
    const cam = this.stage.camera;
    const target = new Vector3(f.x, h * 0.55, f.z);
    const dir = cam.position.clone().sub(this.stage.controls.target).setY(0);
    if (dir.lengthSq() < 1) dir.set(1, 0, 1);
    dir.normalize();
    const dist = Math.max(70, h * 1.6 + Math.max(f.w, f.d) * 2.5);
    const toPos = target
      .clone()
      .add(dir.multiplyScalar(dist))
      .setY(h * 0.55 + dist * 0.65);
    return this.moveCamera(toPos, target, this.reducedMotion ? 1 : duration);
  }

  moveCamera(toPos: Vector3, toTarget: Vector3, duration: number): Promise<void> {
    this.move?.resolve();
    return new Promise((resolve) => {
      this.move = {
        fromPos: this.stage.camera.position.clone(),
        toPos,
        fromTarget: this.stage.controls.target.clone(),
        toTarget,
        start: performance.now(),
        duration,
        resolve,
      };
    });
  }

  /** Jump to the end of any camera move in progress (used by the deterministic test hooks). */
  finishMove(): void {
    const m = this.move;
    if (!m) return;
    this.stage.camera.position.copy(m.toPos);
    this.stage.controls.target.copy(m.toTarget);
    this.move = null;
    m.resolve();
  }

  cancelMove(): void {
    if (!this.move) return;
    const r = this.move.resolve;
    this.move = null;
    r();
  }

  // ---- input ---------------------------------------------------------------------------------

  private bindPointer(): void {
    const c = this.shell.canvas;
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.pointerDirty = true;
    });
    c.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.pointerDirty = true;
    });
    c.addEventListener("pointerdown", (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
      this.cancelMove();
    });
    c.addEventListener("pointerup", (e) => {
      const d = this.downAt;
      this.downAt = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || !this.view) return;
      const r = c.getBoundingClientRect();
      this.select(this.pickAt(e.clientX - r.left, e.clientY - r.top));
    });
    c.addEventListener("wheel", () => this.cancelMove(), { passive: true });
  }

  pickAt(x: number, y: number): number {
    if (!this.view) return -1;
    const c = this.shell.canvas;
    return pickBuilding(this.view, this.stage.camera, x, y, c.clientWidth, c.clientHeight);
  }

  private updateHover(): void {
    if (!this.pointerDirty) return;
    this.pointerDirty = false;
    const t = this.shell.tooltip;
    const index = this.pointer && !this.downAt ? this.pickAt(this.pointer.x, this.pointer.y) : -1;
    if (index !== this.hovered) {
      this.hovered = index;
      this.view?.setHovered(index);
    }
    const f = index >= 0 ? this.city?.files[index] : undefined;
    if (!f || !this.pointer) {
      t.hidden = true;
      this.shell.canvas.style.cursor = "";
      return;
    }
    t.textContent = f.path;
    t.style.transform = `translate(${Math.round(this.pointer.x + 14)}px, ${Math.round(this.pointer.y + 14)}px)`;
    t.hidden = false;
    this.shell.canvas.style.cursor = "pointer";
  }

  private bindKeys(): void {
    window.addEventListener("keyup", (e) => {
      this.held.delete(e.key.toLowerCase());
      this.boost = e.shiftKey;
    });
    window.addEventListener("blur", () => this.held.clear());
    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest("input, select, textarea, [contenteditable]") !== null;
      const k = e.key.toLowerCase();
      this.boost = e.shiftKey;
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && FLY_KEYS.has(k)) {
        if (!this.held.has(k)) {
          this.cancelMove();
          for (const fn of this.flyListeners) fn();
        }
        this.held.add(k);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (!this.shell.panel.hidden) this.select(-1);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || !this.timeline) return;
      if (e.key === " " && !target?.closest("button")) {
        e.preventDefault();
        this.timeline.toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.timeline.step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.timeline.step(1);
      }
    });
  }

  private bindPanel(): void {
    this.shell.panelClose.addEventListener("click", () => this.select(-1));
    this.shell.flyButton.addEventListener("click", () => {
      if (this.selected >= 0) void this.flyTo(this.selected);
    });
  }

  private bindTimeline(): void {
    const s = this.shell;
    s.playButton.addEventListener("click", () => this.timeline?.toggle());
    s.scrubber.addEventListener("input", () => {
      if (!this.timeline) return;
      this.timeline.pause();
      this.timeline.setTime(Number(s.scrubber.value));
    });
    s.speed.addEventListener("change", () => this.timeline?.setSpeed(Number(s.speed.value)));
  }

  private bindOpen(): void {
    const s = this.shell;
    s.openButton.addEventListener("click", () => s.fileInput.click());
    s.fileInput.addEventListener("change", () => {
      const file = s.fileInput.files?.[0];
      if (file) void this.openFile(file);
      s.fileInput.value = "";
    });
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      s.root.classList.add("dragging");
    });
    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null) s.root.classList.remove("dragging");
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      s.root.classList.remove("dragging");
      const file = e.dataTransfer?.files[0];
      if (file) void this.openFile(file);
    });
  }

  async openFile(file: File): Promise<void> {
    try {
      const city = await loadCityFile(file);
      this.source = { url: "", label: file.name };
      if (location.pathname !== "/" || location.search) history.replaceState(null, "", "/");
      this.setCity(city);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---- frame loop ----------------------------------------------------------------------------

  private readonly loop = (now: number) => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.frozen) return;
    this.step(dt, now);
    this.stage.render();
  };

  /** Free-roam: slide the camera and its target together over the city, or turn around it. */
  private fly(dt: number, boost: boolean): void {
    const h = this.held;
    if (!h.has("w") && !h.has("a") && !h.has("s") && !h.has("d") && !h.has("q") && !h.has("e")) return;
    const cam = this.stage.camera.position;
    const target = this.stage.controls.target;
    const offset = cam.clone().sub(target);
    const forward = offset.clone().multiplyScalar(-1).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new Vector3(-forward.z, 0, forward.x);
    const speed = Math.max(40, offset.length() * 0.7) * (boost ? 3 : 1) * dt;
    const move = new Vector3();
    if (h.has("w")) move.add(forward);
    if (h.has("s")) move.sub(forward);
    if (h.has("d")) move.add(right);
    if (h.has("a")) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      cam.add(move);
      target.add(move);
    }
    const turn = (h.has("e") ? 1 : 0) - (h.has("q") ? 1 : 0);
    if (turn) {
      offset.applyAxisAngle(new Vector3(0, 1, 0), -turn * 1.4 * dt);
      cam.copy(target).add(offset);
    }
  }

  private step(dt: number, now: number): void {
    this.clock += dt;
    this.fly(dt, this.boost);
    this.timeline?.update(dt);
    for (const fn of this.frameListeners) fn(dt, now);
    if (this.move) {
      const m = this.move;
      const k = Math.min(1, (now - m.start) / m.duration);
      const e = easeInOut(k);
      this.stage.camera.position.lerpVectors(m.fromPos, m.toPos, e);
      this.stage.controls.target.lerpVectors(m.fromTarget, m.toTarget, e);
      if (k >= 1) {
        this.move = null;
        m.resolve();
      }
    }
    this.stage.controls.update();
    this.stage.clampTarget();
    this.view?.setClock(this.clock);
    this.stage.setClock(this.clock);
    this.updateHover();
  }

  /** Render one frame synchronously (used by tests and the recorder). */
  renderNow(): void {
    this.stage.controls.update();
    this.stage.render();
  }
}
