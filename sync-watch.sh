#!/bin/bash
#
# Wrapper for sync.js triggered by launchd WatchPaths.
# Debounces rapid changes (e.g. installing a skill pack writes many files).
# Logs output to ~/Library/Logs/skills-guide-sync.log
#

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/skills-guide-sync.log"
LOCK="/tmp/skills-guide-sync.lock"

# Debounce: skip if another sync ran in the last 5 seconds
if [ -f "$LOCK" ]; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK") ))
  if [ "$lock_age" -lt 5 ]; then
    exit 0
  fi
fi
touch "$LOCK"

{
  echo "──────────────────────────────────"
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Change detected in ~/.claude/skills/"
  node "$SCRIPT_DIR/sync.js" 2>&1
  echo ""
} >> "$LOG"

# Auto-commit + push if data actually changed
cd "$SCRIPT_DIR"
if ! git diff --quiet index.html 2>/dev/null; then
  git add index.html
  git commit -m "sync: auto-update skills data ($(date '+%Y-%m-%d %H:%M'))" >/dev/null 2>&1
  git push >> "$LOG" 2>&1 || echo "$(date) — PUSH FAILED" >> "$LOG"
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Committed and pushed" >> "$LOG"
fi

rm -f "$LOCK"
