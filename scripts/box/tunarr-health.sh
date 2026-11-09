#!/bin/bash
# Craigotv health check, run from cron every 5 min on the box.
# Reads GET /api/debug/streams plus host signals (load, disk and CPU pressure,
# blocked tasks) into ~/tunarr-health.json and appends a line to
# ~/tunarr-alerts.log when: event-loop p99 > 200 ms, any m3u8 > 2000 lines,
# user threads > 1700, a session is older than 12 h, or host disk pressure
# (io "some" avg60) stays above 25% for two checks in a row.
# Alerts repeat at most once an hour. Also rotates ~/tunarr.log at 100 MB.
#
# Diagnosis capture and self-heal (Erik, 2026-11-05):
#  - loop p99 > 200 ms or an m3u8 > 5000 lines saves the full streams JSON,
#    host signals, ps thread/ffmpeg counts and the worst session's channel to
#    ~/tunarr/dumps/<ts>.json (newest 50 kept).
#  - loop p99 > 1000 ms for 3 checks in a row with no sessions restarts Tunarr
#    through ~/tunarr_restart.cron and logs a "heal:" line. Never while someone
#    is watching (sessionCount > 0).
# TUNARR_HEALTH_DRY=1 logs what heal would do without restarting.
URL=${TUNARR_HEALTH_URL:-http://127.0.0.1:8200/api/debug/streams}
OUT=$HOME/tunarr-health.json
ALERTS=$HOME/tunarr-alerts.log
STATE=$HOME/.tunarr-health-state
IOSTATE=$HOME/.tunarr-health-io
HEALSTATE=$HOME/.tunarr-health-slow
DUMPS=$HOME/tunarr/dumps

log=$HOME/tunarr.log
if [ -f "$log" ] && [ "$(stat -c %s "$log")" -gt 104857600 ]; then
  tail -c 20000000 "$log" > "$log.1" && : > "$log"
fi

psi() { awk -v k="$2" '$1==k{split($3,a,"=");print a[2]}' "${TUNARR_HEALTH_PRESSURE:-/proc/pressure}/$1" 2>/dev/null; }
host=$(jq -n --arg load "$(cut -d' ' -f1 /proc/loadavg)" --arg cores "$(nproc)" \
  --arg io "$(psi io some)" --arg iofull "$(psi io full)" --arg cpu "$(psi cpu some)" \
  --arg blocked "$(awk '/^procs_blocked/{print $2}' /proc/stat)" \
  --arg ours "$(ps -u "$USER" -o pcpu= | awk '{s+=$1}END{print s+0}')" \
  '{load1:($load|tonumber), cores:($cores|tonumber), ioSomeAvg60:($io|tonumber? // null),
    ioFullAvg60:($iofull|tonumber? // null), cpuSomeAvg60:($cpu|tonumber? // null),
    procsBlocked:($blocked|tonumber? // null), ourPcpu:($ours|tonumber)}')

reasons=""
if ! curl -sf --max-time 20 "$URL" -o "$OUT.tmp"; then
  rm -f "$OUT.tmp"
  fetch_failed=1
  reasons="health endpoint unreachable or >20s"
else
  jq --argjson host "$host" '. + {host:$host}' "$OUT.tmp" > "$OUT" && rm -f "$OUT.tmp"
  reasons=$(jq -r '[
    (if .loopP99Ms > 200 then "loop p99 \(.loopP99Ms) ms" else empty end),
    (if .maxM3u8Lines > 2000 then "m3u8 \(.maxM3u8Lines) lines" else empty end),
    (if (.userThreads // 0) > 1700 then "threads \(.userThreads)" else empty end),
    (if .maxSessionAgeMs > 43200000 then "session age \(.maxSessionAgeMs/3600000|floor) h" else empty end)
  ] | join("; ")' "$OUT")
fi

# Disk pressure: alert only when it stays high for two checks.
io=$(jq -r '.ioSomeAvg60 // 0' <<<"$host")
iocount=$(cat "$IOSTATE" 2>/dev/null || echo 0)
if awk -v v="$io" 'BEGIN{exit !(v>25)}'; then iocount=$((iocount + 1)); else iocount=0; fi
echo "$iocount" > "$IOSTATE"
if [ "$iocount" -ge 2 ]; then
  r="host disk pressure ${io}% (load $(jq -r .load1 <<<"$host")/$(jq -r .cores <<<"$host"), blocked $(jq -r .procsBlocked <<<"$host"), ours $(jq -r .ourPcpu <<<"$host")% cpu)"
  reasons=${reasons:+$reasons; }$r
fi

p99=0 m3u8=0 sessions=0
if [ -z "$fetch_failed" ]; then
  p99=$(jq -r '.loopP99Ms // 0' "$OUT")
  m3u8=$(jq -r '.maxM3u8Lines // 0' "$OUT")
  sessions=$(jq -r '.sessionCount // 0' "$OUT")
fi

# (1)+(2) Capture a diagnosis, naming the session and channel with the longest m3u8.
if [ -z "$fetch_failed" ] && awk -v p="$p99" -v m="$m3u8" 'BEGIN{exit !(p>200 || m>5000)}'; then
  mkdir -p "$DUMPS"
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  channels=$(curl -sf --max-time 10 http://127.0.0.1:8200/api/channels | jq -c 'map({id,number,name})' 2>/dev/null || echo '[]')
  jq --argjson ch "$channels" \
     --arg threads "$(ps -L -u "$USER" --no-headers | wc -l)" \
     --arg ffmpeg "$(pgrep -u "$USER" -c ffmpeg)" \
     --arg ffargs "$(ps -u "$USER" -o pcpu=,ni=,etime=,args= | grep '[f]fmpeg' | cut -c1-300)" \
     --arg ts "$ts" '
    (.sessions // [] | max_by(.m3u8Lines // 0)) as $w
    | ($w.key // "" | split("_")[0]) as $cid
    | {ts:$ts, worst:{key:$w.key, type:$w.type, agents:$w.agents, ageMs:$w.ageMs, m3u8Lines:$w.m3u8Lines,
                     channel:($ch | map(select(.id==$cid)) | .[0])},
       psThreads:($threads|tonumber), ffmpegProcs:($ffmpeg|tonumber), ffmpeg:($ffargs|split("\n")),
       streams:.}' "$OUT" > "$DUMPS/$ts.json"
  ls -1t "$DUMPS"/*.json 2>/dev/null | tail -n +51 | xargs -r rm -f
  worst=$(jq -r '.worst | "ch \(.channel.number // "?") \(.type // "?") age \((.ageMs // 0)/60000|floor) min agent \((.agents // [])|map(select(.!=null))|join(",")|if .=="" then "-" else . end)"' "$DUMPS/$ts.json")
  [ -n "$reasons" ] && reasons="$reasons [worst: $worst; dump $ts]"
fi

# (3) Self-heal: 3 slow checks in a row and nobody watching.
slow=$(cat "$HEALSTATE" 2>/dev/null || echo 0)
if awk -v p="$p99" 'BEGIN{exit !(p>1000)}'; then slow=$((slow + 1)); else slow=0; fi
if [ "$slow" -ge 3 ]; then
  if [ "$sessions" -eq 0 ]; then
    if [ -n "$TUNARR_HEALTH_DRY" ]; then
      echo "$(date -u +%FT%TZ) heal: DRY would restart Tunarr (loop p99 $p99 ms x$slow checks, 0 sessions)" >> "$ALERTS"
    else
      echo "$(date -u +%FT%TZ) heal: restarting Tunarr (loop p99 $p99 ms x$slow checks, 0 sessions)" >> "$ALERTS"
      pkill -u "$USER" -f '^[^ ]*node bundle[.]cjs'
      sleep 5
      bash "$HOME/tunarr_restart.cron" >/dev/null 2>&1
    fi
    slow=0
  else
    echo "$(date -u +%FT%TZ) heal: skipped, $sessions session(s) watching (loop p99 $p99 ms x$slow checks)" >> "$ALERTS"
  fi
fi
echo "$slow" > "$HEALSTATE"

[ -z "$reasons" ] && exit 0
now=$(date +%s)
last=$(cat "$STATE" 2>/dev/null || echo 0)
if [ $((now - last)) -ge 3600 ]; then
  echo "$(date -u +%FT%TZ) $reasons" >> "$ALERTS"
  echo "$now" > "$STATE"
fi
