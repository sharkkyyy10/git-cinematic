import { type City, ERA_KIND_NAMES } from "@git-cinematic/core/format";
import { el, fmtDate, type Shell } from "./ui.js";

/** Buckets per second at 1× speed: a 128-bucket history replays in about 30 s. */
export const BUCKETS_PER_SECOND = 4.2;
export const ERA_COLORS = ["#5b8def", "#38c39a", "#ff6b3d", "#b48cff"];

export interface TimelineEvents {
  onTime(t: number): void;
  onEra(index: number): void;
  onEnd(): void;
}

export class Timeline {
  time: number;
  playing = false;
  speed = 1;
  private lastEra = -1;
  readonly last: number;

  constructor(
    readonly city: City,
    private readonly shell: Shell,
    private readonly events: TimelineEvents,
  ) {
    this.last = Math.max(0, city.bucketStart.length - 1);
    this.time = this.last;
    const s = shell.scrubber;
    s.max = String(this.last);
    s.value = String(this.time);
    this.renderMarkers();
    this.sync();
  }

  private renderMarkers(): void {
    const m = this.shell.markers;
    m.textContent = "";
    const span = Math.max(1, this.last);
    for (const era of this.city.eras) {
      const left = (era.startBucket / span) * 100;
      const right = ((era.endBucket + (era.endBucket === this.last ? 0 : 1)) / span) * 100;
      const mark = el("span", { class: "marker", title: era.title });
      mark.style.left = `${left}%`;
      mark.style.width = `${Math.max(0.5, right - left)}%`;
      mark.style.background = ERA_COLORS[era.kind] ?? "#888";
      m.append(mark);
    }
  }

  eraAt(t: number): number {
    const b = Math.floor(t);
    return this.city.eras.findIndex((e) => b >= e.startBucket && b <= e.endBucket);
  }

  dateAt(t: number): number {
    const starts = this.city.bucketStart;
    if (starts.length === 0) return this.city.generatedAt;
    const b0 = Math.min(Math.floor(t), starts.length - 1);
    const b1 = Math.min(b0 + 1, starts.length - 1);
    const a = starts[b0] as number;
    const b = b1 === b0 ? this.city.generatedAt : (starts[b1] as number);
    return a + (b - a) * (t - b0);
  }

  play(): void {
    if (this.time >= this.last) this.setTime(0);
    this.playing = true;
    this.lastEra = -1;
    this.sync();
  }

  pause(): void {
    this.playing = false;
    this.sync();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.shell.speed.value = String(s);
  }

  setTime(t: number): void {
    this.time = Math.min(Math.max(t, 0), this.last);
    this.shell.scrubber.value = String(this.time);
    this.sync();
    this.events.onTime(this.time);
  }

  step(delta: number): void {
    this.pause();
    this.setTime(Math.round(this.time) + delta);
  }

  /** Advance playback; called once per frame. */
  update(dt: number): void {
    if (!this.playing) return;
    const next = this.time + dt * this.speed * BUCKETS_PER_SECOND;
    const era = this.eraAt(next);
    if (era !== -1 && era !== this.lastEra) {
      this.lastEra = era;
      this.events.onEra(era);
    }
    if (next >= this.last) {
      this.setTime(this.last);
      this.playing = false;
      this.sync();
      this.events.onEnd();
      return;
    }
    this.setTime(next);
  }

  private sync(): void {
    const b = this.shell.playButton;
    b.textContent = this.playing ? "❚❚" : "▶";
    b.setAttribute("aria-label", this.playing ? "Pause" : "Play");
    const era = this.city.eras[this.eraAt(this.time)];
    this.shell.date.textContent = `${fmtDate(this.dateAt(this.time))}${era ? ` · ${ERA_KIND_NAMES[era.kind]}` : ""}`;
  }
}
