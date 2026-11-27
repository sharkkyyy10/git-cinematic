import { describe, expect, it, vi } from "vitest";
import { type MediaRecorderLike, pickMimeType, Recorder, recordingName } from "../src/record.js";

function mockMediaRecorder(supported: string[]) {
  const instances: FakeRecorder[] = [];
  class FakeRecorder implements MediaRecorderLike {
    static isTypeSupported = (t: string) => supported.includes(t);
    state = "inactive";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(
      readonly stream: MediaStream,
      readonly options?: { mimeType?: string },
    ) {
      instances.push(this);
    }
    start(timeslice?: number) {
      expect(timeslice).toBe(250);
      this.state = "recording";
      this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "video/webm" }) });
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)], { type: "video/webm" }) });
      this.ondataavailable?.({ data: new Blob([]) });
      this.onstop?.();
    }
  }
  return { FakeRecorder, instances };
}

const canvas = () => ({ captureStream: vi.fn((_fps?: number) => ({ id: "stream" }) as unknown as MediaStream) });

describe("Recorder", () => {
  it("prefers VP9 and falls back to VP8", () => {
    expect(pickMimeType(mockMediaRecorder(["video/webm;codecs=vp9", "video/webm"]).FakeRecorder)).toBe(
      "video/webm;codecs=vp9",
    );
    expect(pickMimeType(mockMediaRecorder(["video/webm;codecs=vp8"]).FakeRecorder)).toBe("video/webm;codecs=vp8");
    expect(pickMimeType(mockMediaRecorder([]).FakeRecorder)).toBeNull();
  });

  it("captures the canvas at 60 fps and produces a non-empty webm download", async () => {
    const { FakeRecorder, instances } = mockMediaRecorder(["video/webm;codecs=vp8", "video/webm"]);
    const download = vi.fn();
    const c = canvas();
    const rec = new Recorder(c, { MediaRecorder: FakeRecorder, download });
    rec.start();
    expect(rec.recording).toBe(true);
    expect(c.captureStream).toHaveBeenCalledWith(60);
    expect(instances[0]?.options?.mimeType).toBe("video/webm;codecs=vp8");
    const blob = await rec.stopAndDownload("Acme Platform (demo)");
    expect(blob.size).toBe(4 + 4096);
    expect(blob.type).toBe("video/webm");
    expect(download).toHaveBeenCalledWith(blob, "git-cinematic-acme-platform-demo.webm");
    expect(rec.recording).toBe(false);
  });

  it("rejects an empty recording and unsupported browsers", async () => {
    const { FakeRecorder } = mockMediaRecorder(["video/webm"]);
    class Silent extends FakeRecorder {
      override start() {
        this.state = "recording";
      }
      override stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    const rec = new Recorder(canvas(), { MediaRecorder: Silent, download: vi.fn() });
    rec.start();
    await expect(rec.stop()).rejects.toThrow(/empty/);
    expect(() => new Recorder(canvas(), { MediaRecorder: undefined, download: vi.fn() })).toThrow(/not supported/);
  });

  it("names files after the repository", () => {
    expect(recordingName("git-cinematic")).toBe("git-cinematic-git-cinematic.webm");
    expect(recordingName("///")).toBe("git-cinematic-city.webm");
  });
});
