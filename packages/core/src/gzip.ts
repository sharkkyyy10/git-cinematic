import { gunzipSync, gzipSync } from "node:zlib";
import { type City, decodeCity, encodeCity } from "./format.js";

/** Encode and gzip a city. The gzip header carries no timestamp and a fixed OS byte, so output is reproducible. */
export function packCity(city: City): Buffer {
  const gz = gzipSync(encodeCity(city), { level: 9 });
  gz[9] = 0xff; // OS = unknown, independent of the platform that built it
  return gz;
}

export function unpackCity(bytes: Uint8Array): City {
  return decodeCity(new Uint8Array(gunzipSync(bytes)));
}
