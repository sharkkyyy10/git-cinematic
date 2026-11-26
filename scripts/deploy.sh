#!/usr/bin/env bash
# Deploy the built viewer to Cloudflare Workers Static Assets using curl only.
#
# Usage:  scripts/deploy.sh [assetDir] [--dry-run]
# Env:    CLOUDFLARE_API_TOKEN  (Account > Workers Scripts > Edit)
#         CLOUDFLARE_ACCOUNT_ID
#         CF_WORKER_NAME        (default: git-cinematic)
#         CF_COMPAT_DATE        (default: 2026-11-01)
#         CF_API_BASE           (default: https://api.cloudflare.com/client/v4; override for tests)
#         CF_SMOKE_URL          (optional; skip subdomain lookup and smoke-test this URL)
set -euo pipefail

ASSET_DIR="packages/viewer/dist"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ASSET_DIR="$arg" ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/scripts/cf-assets.mjs"
WORKER_FILE="$ROOT/worker/index.js"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
NAME="${CF_WORKER_NAME:-git-cinematic}"
COMPAT="${CF_COMPAT_DATE:-2026-11-01}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

for bin in curl node; do command -v "$bin" >/dev/null || die "$bin is required"; done
[[ -d "$ASSET_DIR" ]] || die "asset dir '$ASSET_DIR' not found (run npm run build first)"
[[ -f "$WORKER_FILE" ]] || die "worker/index.js missing"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

COUNT="$(node "$HELPER" manifest "$ASSET_DIR" "$WORK")"
log "manifest: $COUNT files from $ASSET_DIR"

if [[ "$DRY_RUN" == 1 ]]; then
  node "$HELPER" metadata "dry-run" "$COMPAT" "$WORK/metadata.json"
  log "dry run OK (manifest + metadata built, nothing uploaded)"
  exit 0
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
ACC="$API/accounts/$CLOUDFLARE_ACCOUNT_ID"

# cf <out-file> <expected-codes-regex> <curl args...>
cf() {
  local out="$1" expect="$2"; shift 2
  local code
  code="$(curl -sS --retry 3 --retry-delay 2 -o "$out" -w '%{http_code}' "$@")" || die "network error calling Cloudflare"
  [[ "$code" =~ ^($expect)$ ]] || { node "$HELPER" check "$out" "HTTP $code" 2>&1 >&2 || true; die "unexpected HTTP $code"; }
}

AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")

log "verifying API token"
cf "$WORK/verify.json" "200|401|403" "${AUTH[@]}" "$API/user/tokens/verify"
if ! node "$HELPER" check "$WORK/verify.json" "token verify" 2>/dev/null; then
  # Account-owned tokens verify on the account endpoint.
  cf "$WORK/verify.json" "200" "${AUTH[@]}" "$ACC/tokens/verify"
  node "$HELPER" check "$WORK/verify.json" "token verify"
fi

log "opening asset upload session"
cf "$WORK/session.json" "200|201" "${AUTH[@]}" -H "Content-Type: application/json" \
  -X POST --data-binary "@$WORK/manifest-body.json" \
  "$ACC/workers/scripts/$NAME/assets-upload-session"
node "$HELPER" check "$WORK/session.json" "upload session"
UPLOAD_JWT="$(node "$HELPER" get "$WORK/session.json" result.jwt)" || die "no upload token returned"
COMPLETION_JWT="$UPLOAD_JWT"

node "$HELPER" buckets "$WORK/session.json" "$WORK" > "$WORK/buckets.txt"
BUCKETS="$(wc -l < "$WORK/buckets.txt" | tr -d ' ')"
if [[ "$BUCKETS" == 0 ]]; then
  log "all assets already uploaded"
else
  i=0
  while read -r line; do
    i=$((i + 1))
    form=()
    for pair in $line; do
      hash="${pair%%|*}"; mime="${pair#*|}"
      form+=(-F "$hash=<$WORK/b64/$hash.b64;type=$mime")
    done
    log "uploading bucket $i/$BUCKETS ($(( ${#form[@]} / 2 )) files)"
    cf "$WORK/upload.json" "200|201" -H "Authorization: Bearer $UPLOAD_JWT" -X POST "${form[@]}" \
      "$ACC/workers/assets/upload?base64=true"
    node "$HELPER" check "$WORK/upload.json" "asset upload"
    if jwt="$(node "$HELPER" get "$WORK/upload.json" result.jwt)"; then COMPLETION_JWT="$jwt"; fi
  done < "$WORK/buckets.txt"
  [[ "$COMPLETION_JWT" != "$UPLOAD_JWT" ]] || die "upload finished without a completion token"
fi

log "deploying worker '$NAME'"
node "$HELPER" metadata "$COMPLETION_JWT" "$COMPAT" "$WORK/metadata.json"
cf "$WORK/script.json" "200|201" "${AUTH[@]}" -X PUT \
  -F "metadata=@$WORK/metadata.json;type=application/json" \
  -F "worker.js=@$WORKER_FILE;filename=worker.js;type=application/javascript+module" \
  "$ACC/workers/scripts/$NAME"
node "$HELPER" check "$WORK/script.json" "script deploy"

if [[ -n "${CF_SMOKE_URL:-}" ]]; then
  URL="${CF_SMOKE_URL%/}"
else
  log "enabling workers.dev route"
  cf "$WORK/sub.json" "200|201" "${AUTH[@]}" -H "Content-Type: application/json" -X POST \
    --data '{"enabled":true,"previews_enabled":false}' "$ACC/workers/scripts/$NAME/subdomain"
  node "$HELPER" check "$WORK/sub.json" "enable workers.dev"
  cf "$WORK/acct-sub.json" "200|404" "${AUTH[@]}" "$ACC/workers/subdomain"
  SUB="$(node "$HELPER" get "$WORK/acct-sub.json" result.subdomain)" \
    || die "no workers.dev subdomain on this account: open Workers & Pages in the dashboard once to claim one, then rerun"
  URL="https://$NAME.$SUB.workers.dev"
fi

log "smoke testing $URL"
ok=0
for _ in $(seq 1 15); do
  if curl -fsS "$URL/" -o "$WORK/home.html" && grep -q "<title>Git-Cinematic" "$WORK/home.html"; then ok=1; break; fi
  sleep 3
done
[[ "$ok" == 1 ]] || die "home page did not come up at $URL"
curl -fsS "$URL/healthz" | grep -qx "ok" || die "/healthz failed"
curl -fsS -H "Sec-Fetch-Mode: navigate" -H "Accept: text/html" "$URL/gh/octo/demo" | grep -q "<title>Git-Cinematic" \
  || die "SPA route fallback failed"
DEMO_SIZE="$(curl -fsS -o /dev/null -w '%{size_download}' "$URL/demo/city.bin")" || die "demo city missing"
[[ "$DEMO_SIZE" -gt 32 ]] || die "demo city is empty"

log "live: $URL"
