#!/usr/bin/env bash
# Create (if needed) github.com/$GH_OWNER/$GH_REPO and push the current branch.
# Usage:  scripts/publish-github.sh
# Env:    GITHUB_TOKEN  (classic: public_repo scope; or taken from `gh auth token`)
#         GH_OWNER      (default: Sharkkyyy10)
#         GH_REPO       (default: git-cinematic)
#         GH_PRIVATE    (default: false)
#         GH_API_BASE   (default: https://api.github.com; override for tests)
#         GIT_REMOTE_URL(default: https://github.com/$GH_OWNER/$GH_REPO.git; override for tests)
set -euo pipefail

OWNER="${GH_OWNER:-Sharkkyyy10}"
REPO="${GH_REPO:-git-cinematic}"
PRIVATE="${GH_PRIVATE:-false}"
API="${GH_API_BASE:-https://api.github.com}"
REMOTE="${GIT_REMOTE_URL:-https://github.com/$OWNER/$REPO.git}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

if [[ -z "${GITHUB_TOKEN:-}" ]] && command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  GITHUB_TOKEN="$(gh auth token)"
fi
: "${GITHUB_TOKEN:?set GITHUB_TOKEN or log in with gh}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse HEAD >/dev/null 2>&1 || die "no commits yet"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
H=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

gh_api() { # gh_api <out> <curl args...>  -> prints HTTP code
  curl -sS -o "$1" -w '%{http_code}' "${H[@]}" "${@:2}" || die "network error calling GitHub"
}
field() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],o);if(v==null)process.exit(2);process.stdout.write(String(v))' "$1" "$2"; }

code="$(gh_api "$WORK/user.json" "$API/user")"
[[ "$code" == 200 ]] || die "token rejected by GitHub (HTTP $code)"
LOGIN="$(field "$WORK/user.json" login)"
[[ "$LOGIN" == "$OWNER" ]] || die "token belongs to '$LOGIN', expected '$OWNER'"

# Identity: every commit in this repo is authored and committed as the owner.
UID_="$(field "$WORK/user.json" id)"
EMAIL="${GIT_AUTHOR_EMAIL_OVERRIDE:-$UID_+$OWNER@users.noreply.github.com}"
git config user.name "$OWNER"
git config user.email "$EMAIL"

BAD="$(git log --format='%an <%ae>%n%cn <%ce>' | sort -u | grep -v -x "$OWNER <$EMAIL>" || true)"
if [[ -n "$BAD" ]]; then
  printf '%s\n' "$BAD" >&2
  die "history contains other identities (listed above); rewrite them before publishing"
fi
if git log --format=%B | grep -qi '^co-authored-by:'; then
  die "history contains Co-Authored-By trailers; remove them before publishing"
fi

code="$(gh_api "$WORK/repo.json" "$API/repos/$OWNER/$REPO")"
if [[ "$code" == 404 ]]; then
  log "creating $OWNER/$REPO"
  body="{\"name\":\"$REPO\",\"private\":$PRIVATE,\"description\":\"Fly through your git history as a living 3D city.\",\"has_wiki\":false}"
  code="$(gh_api "$WORK/create.json" -X POST --data "$body" "$API/user/repos")"
  [[ "$code" == 201 ]] || die "could not create repo (HTTP $code)"
elif [[ "$code" == 200 ]]; then
  log "$OWNER/$REPO already exists"
else
  die "could not read repo (HTTP $code)"
fi

if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$REMOTE"; else git remote add origin "$REMOTE"; fi

BRANCH="$(git symbolic-ref --short HEAD)"
log "pushing $BRANCH"
BASIC="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $BASIC" push -u origin "$BRANCH"

log "done: https://github.com/$OWNER/$REPO"
