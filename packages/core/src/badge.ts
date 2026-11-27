// A self-contained SVG badge for READMEs, in the familiar flat style. No network, no fonts to load.

import { gradeFor, type Health } from "./insights.js";

const COLORS: Record<Health["grade"], string> = {
  A: "#2ea44f",
  B: "#7cb82f",
  C: "#dfb317",
  D: "#fe7d37",
  E: "#e05d44",
};

/** Approximate width of Verdana 11px text, the usual badge font. */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ijlI.,:;|!' ]/.test(ch) ? 3.6 : /[mwMW]/.test(ch) ? 10 : /[A-Z0-9]/.test(ch) ? 7.6 : 6.6;
  return Math.ceil(w);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderBadge(score: number, label = "code health"): string {
  const grade = gradeFor(score);
  const value = `${score} ${grade}`;
  const lw = textWidth(label) + 12;
  const vw = textWidth(value) + 12;
  const w = lw + vw;
  const title = esc(`${label}: ${score}/100 (grade ${grade})`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">
<title>${title}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${COLORS[grade]}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text><text x="${lw + vw / 2}" y="14">${value}</text>
</g>
</svg>
`;
}
