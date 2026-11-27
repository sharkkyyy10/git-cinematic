export const CITY_SIZE = 1000;
export const FOOTPRINT_SHRINK = 0.15;
const STREETS = [0, 4, 2, 1, 0.5];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A centred rectangle in city space: x/z is the centre, w/d the extent. */
export interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface DirBox extends Box {
  path: string;
  depth: number;
}

export interface CityLayout {
  files: Box[];
  dirs: DirBox[];
}

export function fileWeight(locMax: number): number {
  return Math.sqrt(Math.max(locMax, 1)) + 1;
}

export function streetInset(depth: number): number {
  if (depth <= 0) return 0;
  return STREETS[Math.min(depth, 4)] as number;
}

interface Node {
  name: string;
  path: string;
  weight: number;
  file: number; // -1 for directories
  children: Node[];
}

function buildTree(paths: readonly string[], weights: readonly number[]): Node {
  const root: Node = { name: "", path: "", weight: 0, file: -1, children: [] };
  const dirIndex = new Map<string, Node>([["", root]]);
  paths.forEach((p, i) => {
    const parts = p.split("/");
    let parent = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const dirPath = parts.slice(0, k + 1).join("/");
      let dir = dirIndex.get(dirPath);
      if (!dir) {
        dir = { name: parts[k] as string, path: dirPath, weight: 0, file: -1, children: [] };
        dirIndex.set(dirPath, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({
      name: parts[parts.length - 1] as string,
      path: p,
      weight: weights[i] as number,
      file: i,
      children: [],
    });
  });
  const sum = (n: Node): number => {
    if (n.file >= 0) return n.weight;
    n.weight = n.children.reduce((s, c) => s + sum(c), 0);
    // Directories first by weight descending, then path ascending (byte order).
    n.children.sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return n.weight;
  };
  sum(root);
  return root;
}

function worst(row: number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const a of row) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Squarified treemap (Bruls, Huizing, van Wijk). Areas must be sorted descending and sum to rect area. */
export function squarify(areas: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(areas.length);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row: number[] = [areas[i] as number];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j] as number], side) <= worst(row, side)) {
      row.push(areas[j] as number);
      j++;
    }
    const rowSum = row.reduce((s, a) => s + a, 0);
    if (w >= h) {
      // Lay the row out as a column on the left.
      const colW = h > 0 ? rowSum / h : 0;
      let cy = y;
      row.forEach((a, k) => {
        const ch = colW > 0 ? a / colW : 0;
        out[i + k] = { x, y: cy, w: colW, h: ch };
        cy += ch;
      });
      x += colW;
      w -= colW;
    } else {
      const rowH = w > 0 ? rowSum / w : 0;
      let cx = x;
      row.forEach((a, k) => {
        const cw = rowH > 0 ? a / rowH : 0;
        out[i + k] = { x: cx, y, w: cw, h: rowH };
        cx += cw;
      });
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
  return out;
}

function inset(r: Rect, amount: number): Rect {
  const a = Math.min(amount, r.w / 4, r.h / 4);
  return { x: r.x + a, y: r.y + a, w: r.w - 2 * a, h: r.h - 2 * a };
}

/**
 * Lay out every path that ever existed (deleted files included) so buildings never move during
 * replay. Returns file footprints indexed like `paths` and every directory plate except the root.
 */
export function layoutCity(paths: readonly string[], locMax: readonly number[]): CityLayout {
  const weights = locMax.map(fileWeight);
  const root = buildTree(paths, weights);
  const files: Box[] = new Array(paths.length);
  const dirs: DirBox[] = [];
  const half = CITY_SIZE / 2;
  const toBox = (r: Rect): Box => ({ x: r.x + r.w / 2 - half, z: r.y + r.h / 2 - half, w: r.w, d: r.h });

  const place = (node: Node, cell: Rect, depth: number) => {
    if (node.file >= 0) {
      const k = 1 - FOOTPRINT_SHRINK;
      const b = toBox(cell);
      files[node.file] = { x: b.x, z: b.z, w: b.w * k, d: b.d * k };
      return;
    }
    if (depth > 0) dirs.push({ path: node.path, depth, ...toBox(cell) });
    const inner = inset(cell, streetInset(depth));
    const area = inner.w * inner.h;
    const total = node.weight;
    if (node.children.length === 0 || total <= 0) return;
    const areas = node.children.map((c) => (c.weight / total) * area);
    const cells = squarify(areas, inner);
    node.children.forEach((c, k) => {
      place(c, cells[k] as Rect, depth + 1);
    });
  };
  place(root, { x: 0, y: 0, w: CITY_SIZE, h: CITY_SIZE }, 0);
  dirs.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, dirs };
}
