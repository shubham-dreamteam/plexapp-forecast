#!/usr/bin/env bash
# Deploy the PlexApp Forecast dashboard to Cloudflare Pages AND sync source to GitHub.
# Usage:  ./deploy.sh "optional commit message"
# - Deploys from a clean staging dir so the .dev.vars secret is never uploaded.
# - Commits + pushes source to GitHub (the .dev.vars key is gitignored, stays local).
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="f1a42e7359a370c2b754255c88bb2116"  # Shubham@dreamteam.co account (plexapp-forecast project)
cd "$(dirname "$0")"

MSG="${1:-Update dashboard}"

echo "▶ Deploying to Cloudflare Pages…"
STAGE="$(mktemp -d)"
cp index.html usecase.html "$STAGE"/
cp wrangler.toml "$STAGE"/   # carries the D1 binding (goals store) into the deploy
cp -r functions "$STAGE"/functions
( cd "$STAGE" && npx --yes wrangler@4.128.0 pages deploy . \
    --project-name plexapp-forecast --branch main --commit-dirty true )   # pinned: 4.129.0 is broken on npm
rm -rf "$STAGE"

echo "▶ Syncing source to GitHub…"
git add -A
if git diff --cached --quiet; then
  echo "  (no source changes to commit — GitHub already in sync)"
else
  git commit -q -m "$MSG"
  git push -q
  echo "  pushed to $(git remote get-url origin)"
fi

echo "✅ Done — live at https://plexapp-forecast.pages.dev (behind Cloudflare Access)"
