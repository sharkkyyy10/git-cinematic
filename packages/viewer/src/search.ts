/** Fuzzy subsequence match. Higher is better; null means no match. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return null;
  const p = path.toLowerCase();
  const base = p.lastIndexOf("/") + 1;
  let score = 0;
  let pi = 0;
  let prev = -2;
  for (const ch of q) {
    const at = p.indexOf(ch, pi);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 3; // consecutive
    if (at >= base) score += 2; // in the file name
    if (at === 0 || p[at - 1] === "/" || p[at - 1] === "-" || p[at - 1] === "_" || p[at - 1] === ".") score += 2;
    prev = at;
    pi = at + 1;
  }
  if (p.slice(base).includes(q)) score += 10;
  return score - p.length * 0.01;
}

export function searchPaths(query: string, paths: readonly string[], limit = 8): number[] {
  const scored: { i: number; s: number }[] = [];
  paths.forEach((p, i) => {
    const s = fuzzyScore(query, p);
    if (s !== null) scored.push({ i, s });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.i);
}
