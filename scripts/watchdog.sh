#!/bin/bash
# ---------------------------------------------------------------------------
# South Bay Signal — Hung Process Watchdog
# Checks for SBS launchd processes stuck longer than expected.
# Sends a Discord DM when detected so Stephen can screen share and fix.
#
# Install as launchd agent on Mac Mini:
#   cp scripts/watchdog.plist ~/Library/LaunchAgents/org.southbaysignal.watchdog.plist
#   launchctl load ~/Library/LaunchAgents/org.southbaysignal.watchdog.plist
#
# Runs every 15 minutes. Suppresses duplicate alerts for 60 minutes.
# ---------------------------------------------------------------------------

set -uo pipefail

# Load env for Discord webhook
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env.local"

if [ -f "$ENV_FILE" ]; then
  DISCORD_WEBHOOK=$(grep '^DISCORD_WEBHOOK=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"'"'")
fi

if [ -z "${DISCORD_WEBHOOK:-}" ]; then
  echo "$(date '+%Y-%m-%d %H:%M') — No DISCORD_WEBHOOK found, exiting"
  exit 1
fi

# Cooldown: suppress duplicate alerts for 60 minutes
COOLDOWN_FILE="/tmp/sbs-watchdog-last-alert"
COOLDOWN_MINUTES=60

should_alert() {
  if [ ! -f "$COOLDOWN_FILE" ]; then
    return 0  # No previous alert — send it
  fi
  local last_alert
  last_alert=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  local now
  now=$(date +%s)
  local elapsed=$(( (now - last_alert) / 60 ))
  if [ "$elapsed" -ge "$COOLDOWN_MINUTES" ]; then
    return 0  # Cooldown expired — send it
  fi
  return 1  # Still in cooldown — suppress
}

# Process patterns and their max expected runtime in minutes
CHECKS="
publish-from-queue:10
queue-monitor:15
reply-monitor:10
generate-posts:20
generate-events:15
generate-digests:30
generate-around-town:15
generate-restaurant-radar:10
generate-sv-history:10
generate-restaurant-openings:10
playwright-scrapers:15
threads-refresh:5
collect-metrics:10
"

HITS_FILE="/tmp/sbs-watchdog-hits.tmp"
rm -f "$HITS_FILE"

# Parse elapsed time string to minutes
# Format: [[dd-]hh:]mm:ss
parse_etime() {
  local etime="$1"
  local days=0 hours=0 mins=0

  if [[ "$etime" == *-* ]]; then
    days="${etime%%-*}"
    etime="${etime#*-}"
  fi

  local IFS=':'
  local parts=($etime)
  if [ ${#parts[@]} -eq 3 ]; then
    hours=$((10#${parts[0]}))
    mins=$((10#${parts[1]}))
  elif [ ${#parts[@]} -eq 2 ]; then
    mins=$((10#${parts[0]}))
  fi

  echo $(( days * 1440 + hours * 60 + mins ))
}

for check in $CHECKS; do
  [ -z "$check" ] && continue
  pattern="${check%%:*}"
  max_minutes="${check##*:}"

  # Find matching node processes and their elapsed time
  ps -eo pid,etime,command 2>/dev/null | grep "node.*${pattern}" | grep -v grep | while IFS= read -r line; do
    [ -z "$line" ] && continue
    pid=$(echo "$line" | awk '{print $1}')
    etime=$(echo "$line" | awk '{print $2}')
    total_mins=$(parse_etime "$etime")

    if [ "$total_mins" -gt "$max_minutes" ]; then
      echo "${pattern}|${pid}|${total_mins}|${max_minutes}" >> "$HITS_FILE"
    fi
  done
done

# Check for macOS system popups that might be blocking
# Only check for SecurityAgent (password prompts) — other system processes
# like UserNotificationCenter and CoreServicesUIAgent always run and are
# false positives.
POPUP=""
for popup in "SecurityAgent"; do
  if pgrep -x "$popup" > /dev/null 2>&1; then
    POPUP="${POPUP}• ${popup}\n"
  fi
done

# Build alert message
HUNG=""
if [ -f "$HITS_FILE" ]; then
  while IFS='|' read -r pattern pid total max; do
    HUNG="${HUNG}• **${pattern}** (PID ${pid}) — running ${total}min, expected <${max}min\n"
  done < "$HITS_FILE"
  rm -f "$HITS_FILE"
fi

# Send alert if anything is wrong (and cooldown has expired)
if [ -n "$HUNG" ] || [ -n "$POPUP" ]; then
  if should_alert; then
    # Build message parts
    MSG="⚠️ **Mac Mini Watchdog Alert**"

    if [ -n "$HUNG" ]; then
      MSG="${MSG}\n🔴 **Hung SBS processes:**\n${HUNG}"
    fi

    if [ -n "$POPUP" ]; then
      MSG="${MSG}\n🟡 **System popups detected:**\n${POPUP}"
    fi

    MSG="${MSG}📱 Screen share in to check."

    # Properly escape for JSON using python
    JSON_BODY=$(python3 -c "
import json, sys
msg = '''$(echo -e "$MSG")'''
print(json.dumps({'content': msg}))
" 2>/dev/null)

    if [ -n "$JSON_BODY" ]; then
      curl -s -X POST "$DISCORD_WEBHOOK" \
        -H "Content-Type: application/json" \
        -d "$JSON_BODY" > /dev/null

      date +%s > "$COOLDOWN_FILE"
      echo "$(date '+%Y-%m-%d %H:%M') — alert sent"
    else
      echo "$(date '+%Y-%m-%d %H:%M') — failed to build JSON, skipping alert"
    fi
  else
    echo "$(date '+%Y-%m-%d %H:%M') — issues detected but suppressed (cooldown)"
  fi
else
  echo "$(date '+%Y-%m-%d %H:%M') — all clear"
fi
