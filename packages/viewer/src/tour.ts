import { CatmullRomCurve3, Vector3 } from "three";
import type { App } from "./app.js";

export const TOUR_STOP_SECONDS = 4;
export const TOUR_STOPS = 5;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A camera tour along eased splines through the top hotspots, four seconds per stop. */
export class Tour {
  private positions: CatmullRomCurve3 | null = null;
  private targets: CatmullRomCurve3 | null = null;
  private stops: number[] = [];
  private elapsed = 0;
  private reached = -1;
  private finish: (() => void) | null = null;

  constructor(private readonly app: App) {
    app.frameListeners.push((dt) => this.update(dt));
  }

  get active(): boolean {
    return this.positions !== null;
  }

  start(stops = this.app.hotspotOrder.slice(0, TOUR_STOPS)): Promise<void> {
    this.cancel();
    const view = this.app.view;
    if (!view || stops.length === 0) return Promise.resolve();
    const cam = this.app.stage.camera;
    const posPoints = [cam.position.clone()];
    const targetPoints = [this.app.stage.controls.target.clone()];
    const last = this.app.timeline?.last ?? 0;
    stops.forEach((index, k) => {
      const f = view.city.files[index];
      if (!f) return;
      const h = Math.max(view.heightAt(index), view.heightAt(index, last), 6);
      const target = new Vector3(f.x, h * 0.5, f.z);
      const dist = Math.max(90, h * 1.7 + Math.max(f.w, f.d) * 3);
      const angle = 0.7 + k * 1.25;
      posPoints.push(
        target.clone().add(new Vector3(Math.cos(angle) * dist, h * 0.35 + dist * 0.5, Math.sin(angle) * dist)),
      );
      targetPoints.push(target);
    });
    this.positions = new CatmullRomCurve3(posPoints, false, "centripetal");
    this.targets = new CatmullRomCurve3(targetPoints, false, "centripetal");
    this.stops = stops;
    this.elapsed = 0;
    this.reached = -1;
    this.app.cancelMove();
    return new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  update(dt: number): void {
    if (!this.positions || !this.targets) return;
    this.elapsed += dt;
    const segments = this.stops.length;
    const total = segments * TOUR_STOP_SECONDS;
    const t = Math.min(this.elapsed, total);
    const k = Math.min(segments - 1, Math.floor(t / TOUR_STOP_SECONDS));
    const local = (t - k * TOUR_STOP_SECONDS) / TOUR_STOP_SECONDS;
    // Glide for the first 70% of each stop, then hold on the building.
    const u = (k + ease(Math.min(1, local / 0.7))) / segments;
    this.app.stage.camera.position.copy(this.positions.getPoint(u));
    this.app.stage.controls.target.copy(this.targets.getPoint(u));
    if (local >= 0.7 && this.reached < k) {
      this.reached = k;
      this.app.select(this.stops[k] as number);
    }
    if (this.elapsed >= total) this.end();
  }

  cancel(): void {
    if (this.positions) this.end();
  }

  private end(): void {
    this.positions = null;
    this.targets = null;
    const done = this.finish;
    this.finish = null;
    done?.();
  }
}
