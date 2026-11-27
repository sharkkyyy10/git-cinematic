# git-cinematic

Fly through your git history as a living 3D city.

```bash
npx github:sharkkyyy10/git-cinematic#cli analyze   # no install needed
npx github:sharkkyyy10/git-cinematic#cli view
```

```text
git-cinematic analyze [repo=.] [-o .cinematic/city.bin] [--since 2023-01-01] [--max-commits 50000] [--max-files 20000]
git-cinematic view    [city=.cinematic/city.bin] [--port 4173] [--no-open]
git-cinematic report  [city=.cinematic/city.bin] [-o report.md] [--baseline old.bin]
git-cinematic check   [city=.cinematic/city.bin] [--min-health 60] [--baseline old.bin] [--max-drop 5] [--max-new-hotspots 0] [--github]
git-cinematic badge   [city=.cinematic/city.bin] [-o .cinematic/health.svg] [--label "code health"]
```

`check` is a quality gate for CI (exit 1 when a rule fails); `badge` writes an SVG health badge.

`analyze` reads your history with git, prints a health score and the main findings, and writes a
small city file; `view` serves the bundled 3D viewer on 127.0.0.1 and opens it in your browser;
`report` turns a city into a Markdown report with the health score, findings and the history's eras. Nothing is uploaded: the city file holds
paths, counts and scores, never file contents.

Project page, live demo and documentation: https://github.com/sharkkyyy10/git-cinematic
