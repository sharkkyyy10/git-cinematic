#!/usr/bin/env bash
# Publish the packed CLI to the `cli` branch, so it runs straight from GitHub with no registry:
#   npx github:<owner>/git-cinematic#cli analyze
# The branch holds exactly what `npm pack` would ship (package.json, README, LICENSE, dist/),
# with the build-time scripts removed so npm installs it as is. Each run adds one commit on top.
# Usage: scripts/publish-cli-branch.sh   (after npm run build; pushes to origin)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${CLI_BRANCH:-cli}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT"

TARBALL="$(npm pack -w packages/cli --pack-destination "$WORK" --silent | tail -n1)"
tar -xzf "$WORK/$TARBALL" -C "$WORK"
PKG="$WORK/package"
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  delete pkg.scripts;
  delete pkg.devDependencies;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
' "$PKG/package.json"

# Same guard as the commit hooks: nothing from the blocked-terms list may be committed.
TERMS="$ROOT/.git/info/blocked-terms"
if [[ -s "$TERMS" ]] && grep -rinE "$(paste -sd'|' "$TERMS")" "$PKG" >/dev/null; then
  echo "blocked term found in the packed CLI; not publishing" >&2
  exit 1
fi

VERSION="$(node -p 'require(process.argv[1]).version' "$PKG/package.json")"
SOURCE="$(git rev-parse --short HEAD)"
export GIT_INDEX_FILE="$WORK/index"
git --work-tree="$PKG" add -A .
TREE="$(git write-tree)"
PARENT=()
if git fetch -q origin "$BRANCH" 2>/dev/null; then
  PARENT=(-p FETCH_HEAD)
  if [[ "$(git rev-parse FETCH_HEAD^{tree})" == "$TREE" ]]; then
    echo "$BRANCH is already up to date"
    exit 0
  fi
fi
COMMIT="$(git commit-tree "$TREE" "${PARENT[@]}" -m "chore(release): git-cinematic $VERSION from $SOURCE")"
git push -q origin "$COMMIT:refs/heads/$BRANCH"
echo "published $VERSION ($SOURCE) to $BRANCH as $(git rev-parse --short "$COMMIT")"
