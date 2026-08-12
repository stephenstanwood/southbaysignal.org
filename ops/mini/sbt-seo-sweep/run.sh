#!/bin/zsh
# sbt-seo-sweep — weekly Search Console + technical-SEO + opportunity pass over
# southbaytoday.org.
#
# Unlike the Stoa routines, this one works in the MAIN repo rather than an
# isolated worktree: several SBT tasks already mutate that working tree, and the
# shared cooperative lock (repo-lock.sh) is how they stay out of each other's
# way. Taking the lock is therefore mandatory, not defensive.
#
# The live copy is installed to ~/.claude/scheduled-tasks/sbt-seo-sweep/run.sh
# by install.sh. Canonical source: ops/mini/sbt-seo-sweep/run.sh.
set -uo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

RUN_START=$(date +%s)
REPO="$HOME/Projects/southbaytoday.org"
SKILL_REL="ops/mini/sbt-seo-sweep/SKILL.md"
REPO_LOCK="$HOME/.claude/scheduled-tasks/lib/repo-lock.sh"
TASK="sbt-seo-sweep"
TIMEOUT_SECS=3600                          # 60 min — Tuesday 01:15 start finishes by ~02:15

if ! command -v gtimeout >/dev/null 2>&1; then
  echo "FATAL: gtimeout not found; install with 'brew install coreutils'" >&2
  exit 69
fi

# --- Claude auth (token lives in the Stoa repo's gitignored .env) -------------
export CLAUDE_CODE_OAUTH_TOKEN="$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$HOME/Projects/stoa.works/.env" 2>/dev/null | cut -d= -f2-)"
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  echo "FATAL: CLAUDE_CODE_OAUTH_TOKEN not found" >&2
  exit 69
fi

# --- shared SBT working-tree lock --------------------------------------------
# Every SBT task defers rather than queues: they are idempotent and run often,
# so skipping one weekly cycle is cheaper than two tasks racing on one tree.
if ! bash "$REPO_LOCK" acquire "$TASK"; then
  echo "seo-sweep: SBT repo lock busy; deferring this run" >&2
  bash "$REPO_LOCK" status || true
  exit 0
fi
trap 'bash "$REPO_LOCK" release "$TASK" 2>/dev/null || true' EXIT INT TERM

cd "$REPO" || exit 1

# Start from current main, but never discard a parallel task's uncommitted work.
git -C "$REPO" fetch origin main || echo "seo-sweep: fetch failed; continuing on local state" >&2
if [ -z "$(git -C "$REPO" status --porcelain)" ]; then
  git -C "$REPO" pull --ff-only origin main || echo "seo-sweep: ff-only pull failed; continuing" >&2
else
  echo "seo-sweep: working tree dirty; skipping pull and leaving existing changes alone" >&2
fi

TODAY="$(date '+%A, %B %-d, %Y')"
SKILL_BODY="$(cat "$REPO/$SKILL_REL")"
PROMPT="TODAY IS ${TODAY}. Search Console data lags roughly three days; anchor every recency claim to THIS date and to the window the report actually covers, never to your training data.

${SKILL_BODY}"

RUN=(/opt/homebrew/bin/claude -p
  --model 'claude-opus-5'
  --permission-mode bypassPermissions
  --max-budget-usd 25
  "$PROMPT")

gtimeout "$TIMEOUT_SECS" "${RUN[@]}" </dev/null
rc=$?

elapsed=$(( $(date +%s) - RUN_START ))
echo "seo-sweep: run.sh finished (claude rc=$rc, ${elapsed}s elapsed) at $(date '+%Y-%m-%d %H:%M:%S')"
exit $rc
