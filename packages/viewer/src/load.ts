import { type City, CityFormatError, decodeCity, MAX_CITY_BYTES } from "@git-cinematic/core/format";

export const DEFAULT_SOURCE = "/demo/city.bin";
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export class LoadError extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
  ) {
    super(`${title}: ${detail}`);
    this.name = "LoadError";
  }
}

export interface Source {
  url: string;
  /** Shown while loading and in error messages. */
  label: string;
  /** A GitHub repository, for share links. */
  github?: { owner: string; repo: string };
}

/** Resolve where the city comes from: ?src=, then /gh/<owner>/<repo>, then the demo. */
export function resolveSource(loc: Pick<Location, "href" | "origin" | "pathname" | "search">): Source {
  const src = new URLSearchParams(loc.search).get("src");
  if (src !== null) {
    let url: URL;
    try {
      url = new URL(src, loc.href);
    } catch {
      throw new LoadError("That city link is not valid", `"${src}" is not a URL.`);
    }
    if (url.origin !== loc.origin && url.protocol !== "https:") {
      throw new LoadError(
        "That city link is not allowed",
        "Cities load from this site or from https:// addresses only.",
      );
    }
    return { url: url.href, label: url.pathname.split("/").pop() || url.href };
  }
  const gh = /^\/gh\/([^/]+)\/([^/]+)\/?$/.exec(loc.pathname);
  if (gh) {
    const owner = decodeURIComponent(gh[1] as string);
    const repo = decodeURIComponent(gh[2] as string);
    if (!NAME.test(owner) || !NAME.test(repo)) {
      throw new LoadError("That repository name is not valid", "Use /gh/<owner>/<repo>.");
    }
    return {
      url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.cinematic/city.bin`,
      label: `${owner}/${repo}`,
      github: { owner, repo },
    };
  }
  return { url: new URL(DEFAULT_SOURCE, loc.href).href, label: "demo" };
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new LoadError("This city is too large", "City files are limited to 64 MB.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Gunzip and decode city bytes. */
export async function decodeCityBytes(bytes: Uint8Array): Promise<City> {
  if (bytes.byteLength > MAX_CITY_BYTES)
    throw new LoadError("This city is too large", "City files are limited to 64 MB.");
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new LoadError("This is not a city file", "Expected a gzip-compressed city.bin.");
  }
  let raw: Uint8Array;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    raw = await readLimited(stream, MAX_CITY_BYTES);
  } catch (e) {
    if (e instanceof LoadError) throw e;
    throw new LoadError("This city file is damaged", "It could not be decompressed.");
  }
  try {
    return decodeCity(raw);
  } catch (e) {
    if (e instanceof CityFormatError) throw new LoadError("This city file is damaged", `${e.message}.`);
    throw e;
  }
}

export async function loadCity(source: Source, fetchImpl: typeof fetch = fetch): Promise<City> {
  let res: Response;
  try {
    res = await fetchImpl(source.url, { credentials: "omit" });
  } catch {
    throw new LoadError("Could not reach the city", `The request for ${source.label} failed. Check your connection.`);
  }
  if (res.status === 404) {
    throw new LoadError(
      `No city found for ${source.label}`,
      source.github
        ? "The repository has no .cinematic/city.bin on its default branch (or it is private)."
        : "The city file does not exist.",
    );
  }
  if (!res.ok || !res.body) throw new LoadError("Could not load the city", `The server answered HTTP ${res.status}.`);
  return decodeCityBytes(await readLimited(res.body, MAX_CITY_BYTES));
}

export async function loadCityFile(file: File): Promise<City> {
  if (file.size > MAX_CITY_BYTES) throw new LoadError("This city is too large", "City files are limited to 64 MB.");
  return decodeCityBytes(new Uint8Array(await file.arrayBuffer()));
}
