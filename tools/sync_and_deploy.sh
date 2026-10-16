#!/usr/bin/env bash
# Sync venue photos -> rebuild static gig fallback -> commit -> push -> deploy.
#
# Usage (from anywhere):
#   bash /Users/kyledavis/Projects/asoftfocus-web/site/tools/sync_and_deploy.sh
#
# Safe to run on a schedule: if nothing changed it exits without committing or deploying.
# Only commits generated files (venue WebPs + manifest, index.html gig fallback, .ics files),
# never the raw ../venue-photos folder or any other uncommitted work.
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SITE_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

GENERATED=(assets/images/venues index.html weddings.html private-events.html assets/ics)

python3 tools/sync_venue_photos.py
python3 tools/prerender_gigs.py

if [[ -z "$(git status --porcelain -- "${GENERATED[@]}")" ]]; then
  echo "No changes — nothing to commit or deploy."
  exit 0
fi

git add -A -- "${GENERATED[@]}"
git commit -q -m "Sync venue photos and gig fallback ($(date '+%Y-%m-%d %H:%M'))"
git push -q origin main
wrangler pages deploy . --project-name=asoftfocus --branch=main --commit-dirty=true
echo "Deployed commit $(git rev-parse --short HEAD)"
