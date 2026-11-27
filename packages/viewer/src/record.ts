// Canvas recording with MediaRecorder: VP9 WebM, falling back to VP8, then plain WebM.

export const MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export interface MediaRecorderLike {
  start(timeslice?: number): void;
  stop(): void;
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror?: ((e: unknown) => void) | null;
}

export interface MediaRecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string; videoBitsPerSecond?: number }): MediaRecorderLike;
  isTypeSupported(type: string): boolean;
}

export interface RecorderEnv {
  MediaRecorder: MediaRecorderCtor | undefined;
  download(blob: Blob, filename: string): void;
}

export function pickMimeType(mr: MediaRecorderCtor): string | null {
  return MIME_CANDIDATES.find((t) => mr.isTypeSupported(t)) ?? null;
}

export function recordingName(repo: string): string {
  const slug =
    repo
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "city";
  return `git-cinematic-${slug}.webm`;
}

export class Recorder {
  private recorder: MediaRecorderLike | null = null;
  private chunks: Blob[] = [];
  private done: Promise<Blob> | null = null;
  readonly mimeType: string;

  constructor(
    private readonly canvas: { captureStream(fps?: number): MediaStream },
    private readonly env: RecorderEnv,
  ) {
    if (!env.MediaRecorder || typeof canvas.captureStream !== "function") {
      throw new Error("Recording is not supported in this browser");
    }
    const mime = pickMimeType(env.MediaRecorder);
    if (!mime) throw new Error("This browser cannot record WebM video");
    this.mimeType = mime;
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  start(): void {
    if (this.recorder) return;
    const Ctor = this.env.MediaRecorder as MediaRecorderCtor;
    const stream = this.canvas.captureStream(60);
    const rec = new Ctor(stream, { mimeType: this.mimeType, videoBitsPerSecond: 12_000_000 });
    this.chunks = [];
    this.done = new Promise<Blob>((resolve, reject) => {
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      rec.onstop = () => resolve(new Blob(this.chunks, { type: "video/webm" }));
      rec.onerror = (e) => reject(e instanceof Error ? e : new Error("Recording failed"));
    });
    rec.start(250);
    this.recorder = rec;
  }

  /** Stop and return the finished video. */
  async stop(): Promise<Blob> {
    const rec = this.recorder;
    const done = this.done;
    if (!rec || !done) throw new Error("Not recording");
    this.recorder = null;
    if (rec.state !== "inactive") rec.stop();
    const blob = await done;
    if (blob.size === 0) throw new Error("The recording is empty");
    return blob;
  }

  async stopAndDownload(repo: string): Promise<Blob> {
    const blob = await this.stop();
    this.env.download(blob, recordingName(repo));
    return blob;
  }
}

export function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
