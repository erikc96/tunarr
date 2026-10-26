#!/bin/bash
# Craigotv health check, run from cron every 5 min on the box.
# Reads GET /api/debug/streams and appends a line to ~/tunarr-alerts.log when
# event-loop p99 > 200 ms, any m3u8 > 2000 lines, user threads > 1700, or a
# session is older than 12 h. The latest reading is in ~/tunarr-health.json.
# Alerts repeat at most once an hour per reason. Also rotates ~/tunarr.log
# (the stdout capture) when it passes 100 MB.
URL=http://127.0.0.1:8200/api/debug/streams
OUT=$HOME/tunarr-health.json
ALERTS=$HOME/tunarr-alerts.log
STATE=$HOME/.tunarr-health-state

log=$HOME/tunarr.log
if [ -f "$log" ] && [ "$(stat -c %s "$log")" -gt 104857600 ]; then
  tail -c 20000000 "$log" > "$log.1" && : > "$log"
fi

if ! curl -sf --max-time 20 "$URL" -o "$OUT.tmp"; then
  rm -f "$OUT.tmp"
  reasons="health endpoint unreachable or >20s"
else
  mv "$OUT.tmp" "$OUT"
  reasons=$(jq -r '[
    (if .loopP99Ms > 200 then "loop p99 \(.loopP99Ms) ms" else empty end),
    (if .maxM3u8Lines > 2000 then "m3u8 \(.maxM3u8Lines) lines" else empty end),
    (if (.userThreads // 0) > 1700 then "threads \(.userThreads)" else empty end),
    (if .maxSessionAgeMs > 43200000 then "session age \(.maxSessionAgeMs/3600000|floor) h" else empty end)
  ] | join("; ")' "$OUT")
fi

[ -z "$reasons" ] && exit 0
now=$(date +%s)
last=$(cat "$STATE" 2>/dev/null || echo 0)
if [ $((now - last)) -ge 3600 ]; then
  echo "$(date -u +%FT%TZ) $reasons" >> "$ALERTS"
  echo "$now" > "$STATE"
fi
