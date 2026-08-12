#!/bin/zsh
# install.sh — idempotent installer for the sbt-seo-sweep weekly routine.
# Run on the Mac Mini: ops/mini/sbt-seo-sweep/install.sh
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

REPO="$HOME/Projects/southbaytoday.org"
SRC="$REPO/ops/mini/sbt-seo-sweep"
LOCAL_DIR="$HOME/.claude/scheduled-tasks/sbt-seo-sweep"
LABEL="org.southbaytoday.seo-sweep"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

echo "→ ensuring log dir"
mkdir -p "$REPO/data/logs"

echo "→ marking scripts executable"
chmod +x "$SRC/run.sh" "$SRC/send-seo-dm.mjs" "$SRC/install.sh"

echo "→ installing Mini-local entrypoint + skill"
mkdir -p "$LOCAL_DIR"
cp "$SRC/run.sh" "$LOCAL_DIR/run.sh"
cp "$SRC/SKILL.md" "$LOCAL_DIR/SKILL.md"
chmod +x "$LOCAL_DIR/run.sh"

echo "→ installing launchd plist"
plutil -lint "$SRC/$LABEL.plist"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
fi
cp "$SRC/$LABEL.plist" "$PLIST_DEST"
launchctl bootstrap "$DOMAIN" "$PLIST_DEST"
launchctl enable "$DOMAIN/$LABEL"

echo "✓ installed. Next run: Tuesday 01:15 local."
echo "  Manual test run:  zsh $LOCAL_DIR/run.sh"
echo "  Kick via launchd: launchctl kickstart -k $DOMAIN/$LABEL"
echo "  Logs: $REPO/data/logs/sbt-seo-sweep.{stdout,stderr}.log"
echo
echo "  Search Console leg needs GSC_SERVICE_ACCOUNT_JSON in $REPO/.env.local"
echo "  (the sweep runs its crawl legs regardless, and reports the gap once)."
