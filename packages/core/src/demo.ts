// Seeded simulation of a ~2,400-file, six-year monorepo. It feeds the same pipeline as a real
// repository and produces the landing-page city. Same seed, same bytes.
import { buildCity } from "./city.js";
import type { City } from "./format.js";
import type { Author, CommitEvent, FileChange, IngestFile, IngestResult } from "./ingest.js";
import { buildModel } from "./metrics.js";

export const DEMO_SEED = 0xc1714;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400;
const WEEK = 7 * DAY;
const START = Date.UTC(2019, 0, 7) / 1000;
const WEEKS = 6 * 52;

interface District {
  root: string;
  dirs: string[];
  ext: string;
  /** Week the district appears. */
  born: number;
  /** Week the district is removed (cleanup), if ever. */
  removed?: number;
  /** Relative share of activity. */
  weight: number;
  /** Target number of files. */
  size: number;
  /** Fix waves: [startWeek, endWeek]. */
  fixWaves?: [number, number][];
  /** Files that change together with everything (high centrality, few fixes). */
  core?: boolean;
}

const DISTRICTS: District[] = [
  {
    root: "packages/shared",
    dirs: ["src/core", "src/util", "src/types"],
    ext: "ts",
    born: 0,
    weight: 3,
    size: 70,
    core: true,
  },
  {
    root: "packages/api",
    dirs: ["src/routes", "src/models", "src/middleware", "src/services", "test"],
    ext: "ts",
    born: 0,
    weight: 5,
    size: 420,
  },
  {
    root: "packages/web",
    dirs: ["src/pages", "src/components", "src/hooks", "src/styles", "test"],
    ext: "tsx",
    born: 6,
    weight: 5,
    size: 460,
  },
  {
    root: "packages/billing",
    dirs: ["src/invoices", "src/payments", "src/tax", "test"],
    ext: "ts",
    born: 30,
    weight: 3,
    size: 170,
    fixWaves: [[96, 118]],
  },
  {
    root: "packages/auth",
    dirs: ["src/session", "src/oauth", "src/policies", "test"],
    ext: "ts",
    born: 18,
    weight: 3,
    size: 140,
    fixWaves: [[270, 311]],
  },
  {
    root: "packages/search",
    dirs: ["src/index", "src/query", "src/ranking", "test"],
    ext: "ts",
    born: 70,
    weight: 3,
    size: 170,
    fixWaves: [[150, 172]],
  },
  {
    root: "packages/ui-kit",
    dirs: ["src/buttons", "src/forms", "src/layout", "src/theme", "stories"],
    ext: "tsx",
    born: 40,
    weight: 3,
    size: 190,
  },
  {
    root: "packages/mobile",
    dirs: ["app/screens", "app/navigation", "app/native", "test"],
    ext: "ts",
    born: 120,
    weight: 4,
    size: 320,
  },
  {
    root: "services/gateway",
    dirs: ["cmd", "internal/proxy", "internal/auth"],
    ext: "go",
    born: 60,
    weight: 2,
    size: 90,
  },
  {
    root: "services/worker",
    dirs: ["cmd", "internal/jobs", "internal/queue"],
    ext: "go",
    born: 90,
    weight: 2,
    size: 100,
  },
  { root: "infra", dirs: ["terraform", "k8s/base", "k8s/overlays"], ext: "yaml", born: 10, weight: 1, size: 90 },
  { root: "docs", dirs: ["guides", "adr", "api"], ext: "md", born: 4, weight: 1, size: 80 },
  {
    root: "legacy/monolith",
    dirs: ["app/controllers", "app/models", "app/views", "lib"],
    ext: "rb",
    born: 0,
    removed: 208,
    weight: 4,
    size: 380,
  },
];

/** Activity per era, so the film has clear chapters: [fromWeek, multiplier]. */
const ACTIVITY: [number, number][] = [
  [0, 0.7],
  [52, 2.4],
  [96, 1.1],
  [119, 0.5],
  [150, 1.6],
  [173, 0.75],
  [200, 0.35],
  [227, 1.3],
  [270, 2.2],
];

function activityAt(week: number): number {
  let m = 1;
  for (const [from, v] of ACTIVITY) if (week >= from) m = v;
  return m;
}

const RENAME = { week: 236, from: "packages/ui-kit", to: "packages/design-system" };
const CLEANUP: [number, number] = [200, 226];

const AUTHORS: { name: string; join: number; leave: number }[] = [
  { name: "Maya Okafor", join: 0, leave: WEEKS },
  { name: "Lars Lindqvist", join: 0, leave: 150 },
  { name: "Priya Raman", join: 8, leave: WEEKS },
  { name: "Tomás Ferreira", join: 20, leave: 190 },
  { name: "Aiko Tanaka", join: 35, leave: WEEKS },
  { name: "Noah Brennan", join: 60, leave: 240 },
  { name: "Zainab Haddad", join: 90, leave: WEEKS },
  { name: "Ivan Petrov", join: 110, leave: 200 },
  { name: "Chloé Martin", join: 140, leave: WEEKS },
  { name: "Samuel Osei", join: 170, leave: WEEKS },
  { name: "Elena Rossi", join: 210, leave: WEEKS },
  { name: "Kenji Watanabe", join: 250, leave: WEEKS },
];

const WORDS = [
  "cache",
  "retry",
  "session",
  "invoice",
  "token",
  "router",
  "schema",
  "queue",
  "index",
  "layout",
  "theme",
  "webhook",
  "export",
  "pagination",
  "upload",
  "parser",
  "metrics",
  "locale",
  "timeout",
  "search",
];
const FEAT = [
  "feat: add",
  "feat: support",
  "refactor: simplify",
  "perf: speed up",
  "chore: tidy",
  "docs: describe",
  "test: cover",
];
const FIX = ["fix: handle", "fix: guard", "fix: crash in", "fix: race in", "hotfix: revert", "fix: regression in"];

interface SimFile {
  id: number;
  district: number;
  dir: string;
  name: string;
  lines: number;
  deleted: boolean;
}

export function simulateDemo(seed = DEMO_SEED): IngestResult {
  const rnd = mulberry32(seed);
  // The rename mutates district roots, so every run works on its own copy.
  const districts: District[] = DISTRICTS.map((d) => ({ ...d }));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const files: SimFile[] = [];
  const byDistrict: SimFile[][] = districts.map(() => []);
  const commits: CommitEvent[] = [];
  const names = new Set<string>();

  const newFile = (d: number): SimFile => {
    const district = districts[d] as District;
    const dir = pick(district.dirs);
    let name = "";
    for (let tries = 0; tries < 50; tries++) {
      name = `${pick(WORDS)}${tries > 10 ? `-${tries}` : rnd() < 0.5 ? `-${pick(WORDS)}` : ""}.${district.ext}`;
      if (!names.has(`${district.root}/${dir}/${name}`)) break;
    }
    names.add(`${district.root}/${dir}/${name}`);
    const f: SimFile = { id: files.length, district: d, dir, name, lines: 0, deleted: false };
    files.push(f);
    byDistrict[d]?.push(f);
    return f;
  };

  const activeAuthors = (week: number) =>
    AUTHORS.map((a, i) => ({ a, i })).filter(({ a }) => week >= a.join && week < a.leave);

  for (let week = 0; week < WEEKS; week++) {
    const authors = activeAuthors(week);
    // Activity: ramp-up, an expansion burst in year two, a steady middle and a busy final year.
    const base = 22 * activityAt(week);
    const commitCount = Math.max(1, Math.round(base * (0.85 + rnd() * 0.3)));
    for (let c = 0; c < commitCount; c++) {
      const time = START + week * WEEK + Math.floor(rnd() * WEEK);
      const author = pick(authors).i;
      const live = districts
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => week >= d.born && (d.removed === undefined || week < d.removed));
      let total = 0;
      for (const { d } of live) total += d.weight * (d.fixWaves?.some(([s, e]) => week >= s && week <= e) ? 30 : 1);
      let r = rnd() * total;
      let di = live[0]?.i ?? 0;
      for (const { d, i } of live) {
        r -= d.weight * (d.fixWaves?.some(([s, e]) => week >= s && week <= e) ? 30 : 1);
        if (r <= 0) {
          di = i;
          break;
        }
      }
      const district = districts[di] as District;
      const inWave = district.fixWaves?.some(([s, e]) => week >= s && week <= e) ?? false;
      const inCleanup = week >= CLEANUP[0] && week <= CLEANUP[1];
      const isFix = inWave ? rnd() < 0.85 : rnd() < 0.06;
      const alive = (byDistrict[di] as SimFile[]).filter((f) => !f.deleted);
      const changes: FileChange[] = [];
      const touched = new Set<number>();
      const touch = (f: SimFile, added: number, deleted: number) => {
        if (touched.has(f.id)) return;
        touched.add(f.id);
        const del = Math.min(deleted, f.lines);
        f.lines += added - del;
        changes.push({ fileId: f.id, added, deleted: del });
      };
      const growth = alive.length < district.size && !inCleanup && rnd() < (week - district.born < 20 ? 0.8 : 0.42);
      if (growth || alive.length === 0) touch(newFile(di), 20 + Math.floor(rnd() * 220), 0);
      const n = 1 + Math.floor(rnd() * rnd() * 6);
      for (let k = 0; k < n && alive.length; k++) {
        // Skew towards a few busy files per district so hotspots emerge.
        const f = alive[Math.floor(rnd() * rnd() * alive.length)] as SimFile;
        if (isFix) touch(f, 2 + Math.floor(rnd() * 25), 1 + Math.floor(rnd() * 15));
        else if (inCleanup) touch(f, Math.floor(rnd() * 8), 15 + Math.floor(rnd() * 90));
        else touch(f, 5 + Math.floor(rnd() * 90), Math.floor(rnd() * 30));
      }
      // Shared core files ride along with a third of all commits: calm, central monoliths.
      if (!district.core && !isFix && !inCleanup && rnd() < 0.16) {
        const core = (byDistrict[0] as SimFile[]).filter((f) => !f.deleted).slice(0, 8);
        if (core.length) touch(pick(core), 1 + Math.floor(rnd() * 8), Math.floor(rnd() * 8));
      }
      if (changes.length === 0) continue;
      const word = pick(WORDS);
      const subject = isFix ? `${pick(FIX)} ${word} ${district.root.split("/")[1]}` : `${pick(FEAT)} ${word}`;
      commits.push({ sha: "", time, authorIndex: author, subject, changes });
    }

    // The legacy monolith is removed in a series of deletions during the cleanup era.
    for (const [di, d] of districts.entries()) {
      if (d.removed === undefined || week < CLEANUP[0] || week >= d.removed) continue;
      const alive = (byDistrict[di] as SimFile[]).filter((f) => !f.deleted);
      const share = Math.ceil(alive.length / Math.max(1, d.removed - week));
      const doomed = alive.slice(0, share);
      for (let i = 0; i < doomed.length; i += 40) {
        const batch = doomed.slice(i, i + 40);
        const changes = batch.map((f) => {
          const c = { fileId: f.id, added: 0, deleted: f.lines };
          f.lines = 0;
          f.deleted = true;
          return c;
        });
        commits.push({
          sha: "",
          time: START + week * WEEK + DAY * 3 + i,
          authorIndex: 0,
          subject: `chore: remove legacy ${batch[0]?.dir.split("/").pop()}`,
          changes,
        });
      }
    }

    if (week === RENAME.week) {
      // One big rename: a mass commit that moves the whole UI kit.
      const di = districts.findIndex((d) => d.root === RENAME.from);
      const moved = (byDistrict[di] as SimFile[]).filter((f) => !f.deleted);
      (districts[di] as District).root = RENAME.to;
      commits.push({
        sha: "",
        time: START + week * WEEK + DAY,
        authorIndex: 2,
        subject: "refactor: rename ui-kit to design-system",
        changes: moved.map((f) => ({ fileId: f.id, added: 0, deleted: 0 })),
      });
    }
  }

  commits.sort((a, b) => a.time - b.time);
  commits.forEach((c, i) => {
    c.sha = i.toString(16).padStart(40, "0");
  });
  const ingestFiles: IngestFile[] = files.map((f) => ({
    path: `${(districts[f.district] as District).root}/${f.dir}/${f.name}`,
    binary: false,
    loc: f.deleted ? 0 : f.lines,
    deleted: f.deleted,
  }));
  const authors: Author[] = AUTHORS.map((a) => ({
    name: a.name,
    email: `${a.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
  }));
  return { repoName: "acme-platform (demo)", head: "0".repeat(40), commits, files: ingestFiles, authors };
}

export function buildDemoCity(seed = DEMO_SEED): City {
  const ing = simulateDemo(seed);
  const last = ing.commits[ing.commits.length - 1]?.time ?? START;
  return buildCity(buildModel(ing), { generatedAt: last });
}
