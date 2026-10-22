#!/bin/zsh
# Daily refresh, run by launchd (scripts/launchd/local.aotd-archive.refresh.plist).
# Keeps the Mac awake for the run, appends output to data/logs/refresh.log, and
# shows a notification when new posts were added or a step failed.
set -u
cd "${0:A:h}/.."
mkdir -p data/logs
LOG=data/logs/refresh.log
OUT=$(mktemp)

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z')"
  /usr/bin/caffeinate -i .venv/bin/python scripts/refresh.py
  echo "=== exit $?"
} > "$OUT" 2>&1

cat "$OUT" >> "$LOG"
# Keep the log from growing without bound.
if [[ $(wc -l < "$LOG") -gt 5000 ]]; then
  tail -n 3000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if grep -q "^=== exit [1-9]" "$OUT"; then
  /usr/bin/osascript -e 'display notification "The daily refresh failed — see data/logs/refresh.log" with title "Artist of the Day Archive"'
elif summary=$(grep -m1 -E "^Done: [1-9][0-9]* new" "$OUT"); then
  /usr/bin/osascript -e "display notification \"$summary\" with title \"Artist of the Day Archive\""
fi
rm -f "$OUT"
