#!/usr/bin/env bash
# Lighthouse accessibility per key page, authenticated via session cookie.
set -uo pipefail
cd "$(dirname "$0")/../.."
export CHROME_PATH="/Users/troy/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
# Re-auth before running: fetch /api/csrf-token, POST /api/auth/login (dev@ship.local/admin123),
# then export SESSION_ID from the returned session_id cookie. See audit/shipshape.config.yaml `auth:`.
COOKIE="session_id=${SESSION_ID:?export SESSION_ID from a fresh login before running}"
WIKI="${WIKI_DOC_ID:-442f288a-ad31-47df-bbb7-17303fb291e1}"
BASE="http://localhost:5173"
OUT="audit/a11y/lighthouse"
mkdir -p "$OUT"

declare -a NAMES=("dashboard" "document" "issues" "weeks" "search")
declare -a PATHS=("/my-week" "/documents/$WIKI" "/issues" "/weeks" "/search")

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"; url="$BASE${PATHS[$i]}"
  echo ">>> lighthouse $name  $url"
  npx --yes lighthouse@11 "$url" \
    --only-categories=accessibility \
    --extra-headers="{\"Cookie\":\"$COOKIE\"}" \
    --chrome-flags="--headless=new --no-sandbox --disable-gpu" \
    --preset=desktop \
    --output=json --output=html \
    --output-path="$OUT/$name" \
    --quiet 2>"$OUT/$name.stderr" || echo "  (lighthouse exited non-zero for $name)"
  score=$(python3 -c "import json;print(round(json.load(open('$OUT/$name.report.json'))['categories']['accessibility']['score']*100))" 2>/dev/null || echo "ERR")
  echo "  $name score = $score"
done
echo "=== ALL SCORES ==="
for n in "${NAMES[@]}"; do
  python3 -c "import json;d=json.load(open('$OUT/$n.report.json'));print('$n', round(d['categories']['accessibility']['score']*100))" 2>/dev/null || echo "$n MISSING"
done