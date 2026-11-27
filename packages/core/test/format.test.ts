import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildCity } from "../src/city.js";
import {
  type City,
  CityFormatError,
  decodeCity,
  encodeCity,
  FILE_DELETED,
  HEADER_BYTES,
  hotspots,
  MAX_CITY_BYTES,
  rankPercentile,
} from "../src/format.js";
import { packCity, unpackCity } from "../src/gzip.js";
import { ingest } from "../src/ingest.js";
import { buildModel } from "../src/metrics.js";
import { createFixture, type Fixture, lines } from "./helpers.js";

let fx: Fixture | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
});

function sampleCity(): City {
  const B = 3;
  return {
    flags: 1,
    generatedAt: 1_700_000_000,
    repoName: "démo-repo",
    bucketStart: Uint32Array.from([100, 200, 300]),
    files: [
      {
        path: "src/a.ts",
        x: -1.5,
        z: 2.25,
        w: 3,
        d: 4,
        loc: 10,
        locMax: 12,
        churn: 5,
        fixes: 2,
        centrality: 0.5,
        authors: 3,
        flags: 0,
      },
      {
        path: "src/日本.md",
        x: 0,
        z: 0,
        w: 1,
        d: 1,
        loc: 0,
        locMax: 7,
        churn: 1,
        fixes: 0,
        centrality: 0,
        authors: 1,
        flags: FILE_DELETED,
      },
    ],
    dirs: [{ path: "src", x: 0, z: 0, w: 10, d: 10, depth: 1 }],
    authors: ["Ada", "Bo"],
    eras: [{ title: "Expansion · src", startBucket: 0, endBucket: 2, kind: 1 }],
    history: Uint16Array.from({ length: 2 * B * 2 }, (_, i) => i * 1000),
  };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("city.bin v1", () => {
  it("round-trips encode → decode → encode byte-identically", () => {
    const bytes = encodeCity(sampleCity());
    expect(bytes.byteLength % 4).toBe(0);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("GCTY");
    const decoded = decodeCity(bytes);
    expect(decoded.repoName).toBe("démo-repo");
    expect(decoded.files[1]?.path).toBe("src/日本.md");
    expect(decoded.files[0]).toMatchObject({ x: -1.5, z: 2.25, loc: 10, locMax: 12, churn: 5, fixes: 2, authors: 3 });
    expect(decoded.eras[0]).toEqual({ title: "Expansion · src", startBucket: 0, endBucket: 2, kind: 1 });
    expect([...decoded.history]).toEqual([...sampleCity().history]);
    expect(Buffer.from(encodeCity(decoded)).equals(Buffer.from(bytes))).toBe(true);
    expect(sha(packCity(decoded))).toBe(sha(packCity(sampleCity())));
  });

  it("round-trips through gzip", () => {
    const packed = packCity(sampleCity());
    expect(packed[0]).toBe(0x1f);
    expect(unpackCity(packed).authors).toEqual(["Ada", "Bo"]);
  });

  it("produces the same SHA-256 for two analyses of the same repo", async () => {
    fx = createFixture();
    fx.write("src/a.ts", lines(30));
    fx.write("src/b.ts", lines(10));
    fx.write("lib/c.ts", lines(5));
    fx.commit("feat: start", 0);
    fx.write("src/a.ts", lines(50));
    fx.commit("fix: crash in a", 20);
    fx.move("lib/c.ts", "lib/d.ts");
    fx.commit("refactor: rename", 40);
    const run = async () => sha(packCity(buildCity(buildModel(await ingest(fx?.dir as string)), { generatedAt: 1 })));
    const first = await run();
    expect(await run()).toBe(first);
  });

  describe("decoder rejects bad input", () => {
    const good = () => encodeCity(sampleCity());
    const expectReject = (bytes: Uint8Array, msg: RegExp) => {
      expect(() => decodeCity(bytes)).toThrow(CityFormatError);
      expect(() => decodeCity(bytes)).toThrow(msg);
    };

    it("wrong magic", () => {
      const b = good();
      b[0] = "X".charCodeAt(0);
      expectReject(b, /magic/);
    });
    it("wrong version", () => {
      const b = good();
      b[4] = 2;
      expectReject(b, /version/);
    });
    it("truncated header and body", () => {
      expectReject(good().subarray(0, HEADER_BYTES - 1), /truncated/);
      expectReject(good().subarray(0, good().byteLength - 4), /truncated/);
    });
    it("trailing bytes", () => {
      const b = good();
      const longer = new Uint8Array(b.byteLength + 4);
      longer.set(b);
      expectReject(longer, /size mismatch/);
    });
    it("oversized counts before allocating", () => {
      const files = good();
      new DataView(files.buffer).setUint32(8, 200_001, true);
      expectReject(files, /too many files/);
      const buckets = good();
      new DataView(buckets.buffer).setUint32(16, 1025, true);
      expectReject(buckets, /too many buckets/);
      const huge = good();
      new DataView(huge.buffer).setUint32(8, 150_000, true);
      expectReject(huge, /truncated/);
    });
    it("files larger than 64 MB", () => {
      expectReject(new Uint8Array(MAX_CITY_BYTES + 1), /64 MB/);
    });
    it("a corrupted string table", () => {
      const b = good();
      b[HEADER_BYTES + 2] = 0; // an extra NUL adds an entry
      expectReject(b, /string table/);
    });
    it("garbage that happens to be gzip-sized", () => {
      expect(() => unpackCity(gzipSync(Buffer.from("hello world")))).toThrow(CityFormatError);
    });
  });
});

describe("hotspots", () => {
  it("ranks churn × size by rank percentile and ignores deleted files", () => {
    expect([...rankPercentile([10, 30, 20, 20])]).toEqual([0, 1, 0.5, 0.5]);
    const files = [
      { path: "big-busy", churn: 50, loc: 900, flags: 0 },
      { path: "small-busy", churn: 60, loc: 10, flags: 0 },
      { path: "big-quiet", churn: 1, loc: 1000, flags: 0 },
      { path: "gone", churn: 99, loc: 0, flags: FILE_DELETED },
    ];
    const ranked = hotspots(files);
    expect(files[ranked[0]?.index as number]?.path).toBe("big-busy");
    expect(ranked.find((h) => files[h.index]?.path === "gone")?.score).toBe(0);
  });
});
