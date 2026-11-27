import { describe, expect, it } from "vitest";
import { LoadError, resolveSource } from "../src/load.js";

const at = (href: string) => {
  const u = new URL(href);
  return { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search };
};

describe("resolveSource", () => {
  it("defaults to the demo city", () => {
    expect(resolveSource(at("https://gc.example/")).url).toBe("https://gc.example/demo/city.bin");
  });
  it("loads /gh/<owner>/<repo> from raw.githubusercontent.com", () => {
    const s = resolveSource(at("https://gc.example/gh/octo/hello-world"));
    expect(s.url).toBe("https://raw.githubusercontent.com/octo/hello-world/HEAD/.cinematic/city.bin");
    expect(s.github).toEqual({ owner: "octo", repo: "hello-world" });
  });
  it("accepts same-origin and https ?src= only", () => {
    expect(resolveSource(at("http://localhost:4173/?src=/local/city.bin")).url).toBe(
      "http://localhost:4173/local/city.bin",
    );
    expect(resolveSource(at("https://gc.example/?src=https://cdn.example/c.bin")).url).toBe(
      "https://cdn.example/c.bin",
    );
    expect(() => resolveSource(at("https://gc.example/?src=http://evil.example/c.bin"))).toThrow(LoadError);
    expect(() => resolveSource(at("https://gc.example/?src=javascript:alert(1)"))).toThrow(LoadError);
    expect(() => resolveSource(at("https://gc.example/?src=data:application/octet-stream,xx"))).toThrow(LoadError);
  });
  it("rejects odd repository names", () => {
    expect(() => resolveSource(at("https://gc.example/gh/a%2Fb/c"))).toThrow(LoadError);
  });
});
