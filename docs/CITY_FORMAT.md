# `city.bin` format, version 1

A city file describes a repository's history as a laid-out city. It holds paths, counts and
scores only, never file contents. The reference encoder and decoder are in
[`packages/core/src/format.ts`](../packages/core/src/format.ts); the CLI and the viewer share them.

The file is gzip-compressed. After decompression all integers are little-endian and every
section starts on a 4-byte boundary (the string table and the history are zero-padded).

## Header (40 bytes)

| Offset | Type | Field |
|---|---|---|
| 0 | u8×4 | magic `GCTY` |
| 4 | u16 | version = 1 |
| 6 | u16 | flags (bit0: truncated by `--max-files`) |
| 8 | u32 | fileCount F |
| 12 | u32 | dirCount D |
| 16 | u32 | bucketCount B |
| 20 | u32 | authorCount A |
| 24 | u32 | eraCount E |
| 28 | u32 | stringBytes S |
| 32 | u32 | generatedAt (unix s; the committer time of HEAD, so output is reproducible) |
| 36 | u32 | reserved = 0 |

## Sections, in order

1. **Strings:** S bytes of UTF-8, entries separated by NUL (no trailing NUL), padded to 4 bytes.
   Order: `[0]` repo name, then F file paths, then D dir paths, then A author names, then E era titles.
2. **bucketStart:** u32 × B, unix seconds at the start of each time bucket.
3. **Files:** F records of 40 bytes:

   | Bytes | Fields |
   |---|---|
   | 0–15 | `x f32, z f32, w f32, d f32`: footprint centre and size |
   | 16–31 | `loc u32, locMax u32, churn u32, fixes u32` |
   | 32–35 | `centrality f32` (co-change PageRank, normalised to [0, 1]) |
   | 36–37 | `authors u16` |
   | 38–39 | `flags u16` (bit0 deleted, bit1 binary) |

4. **Dirs:** D records of 20 bytes: `x f32, z f32, w f32, d f32, depth u16, pad u16`. The rectangle is
   the district plate (centre and size); depth 1 is a top-level directory. The root is not stored.
5. **Eras:** E records of 12 bytes: `startBucket u32, endBucket u32, kind u32`.
   Buckets are inclusive. Kinds: 0 steady build, 1 expansion, 2 fix wave, 3 cleanup.
6. **History:** u16 × F × B × 2, file-major then bucket, interleaved as `[height, heat]`, padded to 4 bytes.
   `height` is the cumulative line count at the end of the bucket (capped at 65535);
   `heat` is decaying fix activity scaled to 0–65535.

City coordinates span a 1000 × 1000 square centred at the origin.

## Decoder rules

- Validate the magic and the version.
- Reject files larger than 64 MB, more than 200,000 files or more than 1,024 buckets.
- Check that the summed section sizes equal the byte length before allocating anything.
- Check that the string table has exactly `1 + F + D + A + E` entries and that eras are in range.
- Treat strings as untrusted: the viewer renders them with `textContent` only.

Any change to the layout bumps the version and adds a test.
