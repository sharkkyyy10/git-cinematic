# Git-Cinematic

**Fly through your git history as a living 3D city.**

Every file is a building. Directories are districts, with boulevards, traffic and street lamps
between them. Buildings grow and shrink as lines are added and deleted, files with a run of bug
fixes catch fire and throw off embers, and the files everything else changes with glow like calm
monoliths. Fly over it like an open-world game, or press play and the whole history of the
repository replays as a film, chapter by chapter.

[**Open the live demo →**](https://git-cinematic.shantpaulchanditala.workers.dev)

![A replay of the demo city: districts rise, a fix wave sets the billing district on fire, and the auth district burns at the end](docs/media/hero.gif)

[![CI](https://github.com/sharkkyyy10/git-cinematic/actions/workflows/ci.yml/badge.svg)](https://github.com/sharkkyyy10/git-cinematic/actions/workflows/ci.yml)

## Quickstart

You need Node.js 20 or newer and git. Run it straight from GitHub, nothing to install:

```bash
cd path/to/any/repo
npx github:sharkkyyy10/git-cinematic#cli analyze   # writes .cinematic/city.bin
npx github:sharkkyyy10/git-cinematic#cli view      # opens the city in your browser
```

The `cli` branch holds the ready-built package, so the first run downloads about 450 KB and
starts in seconds. Pass a path to film another repository:
`npx github:sharkkyyy10/git-cinematic#cli analyze ../my-project`.

### From source

```bash
git clone https://github.com/sharkkyyy10/git-cinematic.git
cd git-cinematic
npm ci
npm run build
node packages/cli/dist/main.js analyze
node packages/cli/dist/main.js view
```

`analyze` prints a one-screen summary with the top hotspots and writes `.cinematic/city.bin`.
`view` serves the viewer on `127.0.0.1` and opens your browser. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop.

### Share a city on the web

Commit the city file to a public GitHub repository and open
`https://git-cinematic.shantpaulchanditala.workers.dev/gh/<owner>/<repo>`. The viewer reads
`.cinematic/city.bin` from the repository's default branch, so the link always shows the latest
city you committed. You can also drop any `city.bin` onto the page, or use **Open**.

## What you are looking at

| In the city | Comes from |
|---|---|
| Building height | Lines in the file at that moment (log scale) |
| Building footprint | The largest the file ever grew |
| Fire (inferno glow, flickering above 60%) | Recent bug-fix commits touching the file, decaying over time |
| Lit windows | Co-change centrality: how often the file changes together with others |
| Cool blue rim | Calm monoliths: highly central files that are not on fire |
| District plates | Directories, nested by depth; the biggest are named on the map |
| Boulevards and side streets | The gaps between directories, with traffic and street lamps |
| Red aviation beacons | The tallest files at this moment in history |
| Rising embers | Files burning hottest with recent fixes |
| Coloured chapters on the timeline | Eras: steady build, expansion, fix wave, cleanup |

The side panel for a file shows its lines, churn, fixes, authors, centrality and hotspot rank.
A **hotspot** is a file that is both large and frequently changed: rank-percentile of churn
times rank-percentile of lines.

### Controls

| Key or control | Action |
|---|---|
| <kbd>Space</kbd> | Play or pause the replay |
| <kbd>←</kbd> / <kbd>→</kbd> | Step one time bucket |
| <kbd>/</kbd> | Search files (fuzzy); <kbd>Enter</kbd> flies to the match |
| <kbd>T</kbd> | Camera tour of the top five hotspots |
| <kbd>Esc</kbd> | Close the panel, the search or the tour |
| <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | Fly over the city (hold <kbd>Shift</kbd> to go faster) |
| <kbd>Q</kbd> / <kbd>E</kbd> | Turn left or right |
| Drag, scroll | Orbit and zoom |
| Minimap | Rotates with the camera, shows files on fire; click to travel there |
| Click a building | File details, with **Fly to** |
| **Record** | Records a full replay plus the tour and downloads a WebM video |
| **Share** | Copies the link to this city |

Reduced-motion settings turn off the fly-in, the fire flicker, the embers and the automatic tour.

## How it works

1. **Ingest.** One `git log --numstat -z` process is streamed and parsed incrementally. Renames
   keep a file's identity, so its history follows it. Line counts at `HEAD` come from a single
   `git cat-file --batch`.
2. **Metrics.** Per file: lines, peak lines, churn, fix commits, authors, and PageRank on the
   co-change graph. Commits that touch more than 50 files (reformats, vendor drops, bulk renames)
   are left out of churn, fixes and coupling.
3. **Time.** History is cut into 8 to 128 equal buckets. Each bucket stores every file's height
   and its decaying fix heat.
4. **Eras.** Commits per bucket are segmented on the mean into at most eight chapters, each
   classified and titled after the directory with the most churn, such as `Fix wave · packages/auth`.
5. **Layout.** A squarified treemap over every path that ever existed, so buildings never move
   during the replay.
6. **Render.** One instanced mesh draws the whole city. The history is uploaded once as a GPU
   texture, and the vertex shader interpolates between buckets, so scrubbing the timeline
   changes a single number. Traffic, beacons and embers read the same texture, so they follow
   the replay too. The sky, the procedural outskirts and the traffic are all drawn by shaders,
   and nothing in the world is random between visits.

The whole pipeline is deterministic. The same repository at the same commit produces a
byte-identical city file. On a laptop, a synthetic repository with 50,000 commits and 10,000 files
is analysed in about 4 seconds.

The binary format is documented in [docs/CITY_FORMAT.md](docs/CITY_FORMAT.md), and the full
design is in [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## CLI reference

```text
git-cinematic analyze [repo=.] [-o .cinematic/city.bin] [--since 2023-01-01] [--max-commits 50000] [--max-files 20000]
git-cinematic view    [city=.cinematic/city.bin] [--port 4173] [--no-open]
git-cinematic --version | --help
```

- `--since` analyses commits after a date; `--max-commits` keeps the newest *n*.
- `--max-files` keeps the largest files and folds the rest into one `(other)` building per directory.
- `analyze` exits with 1 when the path is not a git repository or has no commits, and with 2 on bad arguments.

## Privacy

- **Your code never leaves your machine.** `analyze` runs locally and uploads nothing.
- A city file contains file paths, author display names, commit counts and scores. It never contains
  file contents, commit messages or email addresses.
- `view` listens on `127.0.0.1` only.
- The hosted viewer is a static site. It loads a city only from this site, from an `https://` URL
  you give it, or from a file you open, which never leaves your browser.

## Development

```bash
npm ci
npx playwright install chromium
npm run check   # lint, typecheck, unit tests, build, browser tests
npm run demo    # regenerate the seeded demo city (packages/viewer/public/demo/city.bin)
npm run smoke:pack   # pack the CLI, install it into a temp dir and run it through npx
scripts/publish-cli-branch.sh   # after npm run build: publish the packed CLI to the cli branch
```

The workspace has three packages: [`packages/core`](packages/core) (ingest, metrics, eras, layout
and the city format), [`packages/cli`](packages/cli) and [`packages/viewer`](packages/viewer)
(Vite and three.js). The site is deployed to Cloudflare Workers Static Assets with
[`scripts/deploy.sh`](scripts/deploy.sh), which needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
in the environment. `node scripts/hero.mjs` recreates the animation above using the viewer's own
Record button.

## License

[MIT](LICENSE)
