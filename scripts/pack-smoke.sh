#!/usr/bin/env bash
# Pack the CLI, install the tarball into an empty directory and use it through npx:
# analyze this repository, serve it with `view --no-open` and fetch the viewer.
# Usage: scripts/pack-smoke.sh   (after npm run build)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PID=""
cleanup() { [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

cd "$ROOT"
TARBALL="$(npm pack -w packages/cli --pack-destination "$WORK" --silent | tail -n1)"
echo "packed $TARBALL"
LISTING="$(tar -tzf "$WORK/$TARBALL")"
grep -qx "package/dist/viewer/index.html" <<<"$LISTING" || { echo "viewer missing from tarball" >&2; exit 1; }

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "./$TARBALL"
npx --no-install git-cinematic --version

npx --no-install git-cinematic analyze "$ROOT" -o "$WORK/city.bin"
[[ -s "$WORK/city.bin" ]] || { echo "analyze wrote nothing" >&2; exit 1; }

PORT="${SMOKE_PORT:-4319}"
npx --no-install git-cinematic view "$WORK/city.bin" --port "$PORT" --no-open > "$WORK/view.log" 2>&1 &
PID=$!
URL=""
for _ in $(seq 1 50); do
  URL="$(grep -o 'http://127.0.0.1:[0-9]*/' "$WORK/view.log" | head -n1 || true)"
  [[ -n "$URL" ]] && break
  sleep 0.2
done
[[ -n "$URL" ]] || { cat "$WORK/view.log" >&2; echo "view did not start" >&2; exit 1; }

code="$(curl -s -o "$WORK/home.html" -w '%{http_code}' "$URL")"
[[ "$code" == 200 ]] || { echo "GET / returned $code" >&2; exit 1; }
grep -q "<title>Git-Cinematic" "$WORK/home.html" || { echo "unexpected home page" >&2; exit 1; }
size="$(curl -s -o /dev/null -w '%{size_download}' "${URL}local/city.bin")"
[[ "$size" -gt 32 ]] || { echo "city not served" >&2; exit 1; }
echo "pack smoke OK: GET / -> 200, city ${size} bytes at ${URL}"
