import { describe, expect, it } from "vitest";
import { fuzzyScore, searchPaths } from "../src/search.js";

describe("fuzzy search", () => {
  const paths = [
    "packages/viewer/src/timeline.ts",
    "packages/core/src/ingest.ts",
    "packages/core/test/ingest.test.ts",
    "docs/CITY_FORMAT.md",
  ];
  it("matches subsequences and prefers file names", () => {
    expect(fuzzyScore("ingest", paths[1] as string)).not.toBeNull();
    expect(fuzzyScore("zzz", paths[1] as string)).toBeNull();
    expect(searchPaths("ingest", paths)[0]).toBe(1);
    expect(searchPaths("tl", paths)).toContain(0);
    expect(searchPaths("cityfmt", paths)).toEqual([3]);
    expect(searchPaths("", paths)).toEqual([]);
  });
});
