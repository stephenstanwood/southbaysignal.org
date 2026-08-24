#!/bin/bash
set -euo pipefail

REPO="/Users/stephenstanwood/Projects/southbaytoday.org"
DOMAIN="gui/$(id -u)"
MODE="${1:-all}"

# The eventCount pre-commit hook is tracked in the repo but has to be linked
# into the git hooks dir to run. Symlink rather than copy so the tracked file is
# always what executes — the first version of this hook was an untracked copy in
# the Mini's .git/hooks and silently diverged from the repo. Leaves the Mini-only
# pre-push repo-lock backstop alone.
install_hooks() {
  local hooks_dir source target
  # rev-parse returns a path relative to $REPO for a main checkout and an
  # absolute one from a linked worktree, so anchor it before appending.
  hooks_dir="$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ -z "$hooks_dir" ]] && return 0
  [[ "$hooks_dir" != /* ]] && hooks_dir="$REPO/$hooks_dir"
  hooks_dir="$hooks_dir/hooks"
  source="$REPO/scripts/hooks/pre-commit"

  if [[ ! -f "$source" ]]; then
    echo "missing $source" >&2
    return 0
  fi
  if [[ ! -d "$hooks_dir" ]]; then
    mkdir -p "$hooks_dir" || return 0
  fi

  chmod +x "$source" 2>/dev/null || true
  target="$hooks_dir/pre-commit"
  if [[ "$(readlink "$target" 2>/dev/null || true)" != "$source" ]]; then
    ln -sfn "$source" "$target"
    echo "Linked pre-commit hook -> $source"
  fi
}

install_agent() {
  local label="$1"
  local source="$2"
  local target="/Users/stephenstanwood/Library/LaunchAgents/${label}.plist"
  local loaded=0

  if [[ ! -f "$source" ]]; then
    echo "missing $source" >&2
    exit 1
  fi

  plutil -lint "$source"
  if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
    loaded=1
  fi

  if [[ ! -f "$target" ]] || ! cmp -s "$source" "$target"; then
    if [[ "$loaded" -eq 1 ]]; then
      launchctl bootout "$DOMAIN/$label"
    fi
    cp "$source" "$target"
    launchctl bootstrap "$DOMAIN" "$target"
  elif [[ "$loaded" -eq 0 ]]; then
    launchctl bootstrap "$DOMAIN" "$target"
  fi

  launchctl enable "$DOMAIN/$label"
  launchctl print "$DOMAIN/$label" | grep -E 'state =|runs =|last exit code' || true
}

install_hooks

case "$MODE" in
  all)
    install_agent \
      "org.southbaytoday.events-refresh" \
      "$REPO/scripts/events/events-refresh.plist"
    install_agent \
      "org.southbaytoday.events-refresh-watchdog" \
      "$REPO/scripts/events/events-refresh-watchdog.plist"
    ;;
  --refresh-only)
    install_agent \
      "org.southbaytoday.events-refresh" \
      "$REPO/scripts/events/events-refresh.plist"
    ;;
  --watchdog-only)
    install_agent \
      "org.southbaytoday.events-refresh-watchdog" \
      "$REPO/scripts/events/events-refresh-watchdog.plist"
    ;;
  *)
    echo "usage: $0 [--refresh-only|--watchdog-only]" >&2
    exit 2
    ;;
esac

echo "Verified SBT event refresh agents ($MODE)."
echo "Primary: daily 19:15 with 20:45 retry. Watchdog: every 3 hours."
echo "Force now: /opt/homebrew/bin/node $REPO/scripts/events/scheduled-refresh.mjs --force"
