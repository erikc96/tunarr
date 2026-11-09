#!/usr/bin/env python3
"""Turn new lines of the box's ~/tunarr-alerts.log into `bugz propose` filings.

Run from launchd every 15 min. Keeps the number of lines already filed in
~/.local/state/tunarr-alert-poll; bugz dedupes on src_id, so a re-read is safe.
"""
import json, subprocess, sys
from pathlib import Path

BOX = "traps0066@ssh.modestlobster.box.ca"
STATE = Path.home() / ".local/state/tunarr-alert-poll"
done = int(STATE.read_text()) if STATE.exists() else 0

r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", BOX,
                    "cat ~/tunarr-alerts.log 2>/dev/null; true"], capture_output=True, text=True, timeout=60)
if r.returncode:
    sys.exit(f"ssh failed: {r.stderr.strip()}")
lines = [l for l in r.stdout.splitlines() if l.strip()]
if len(lines) < done:  # the box rotated or cleared the log
    done = 0
for line in lines[done:]:
    ts, _, reasons = line.partition(" ")
    bug = {"title": f"Craigotv box alert: {reasons[:80]}", "src_id": f"tunarr-alert:{ts}",
           "subject": "Craigotv (Tunarr on the box) health alert", "kind": "reported",
           "where": "~/Projects/tunarr/scripts/box/tunarr-health.sh",
           "why": f"{line}\nSource: ~/tunarr-alerts.log on {BOX}; GET /api/debug/streams has the detail."}
    p = subprocess.run(["bugz", "propose", "-"], input=json.dumps(bug), text=True,
                       env={"BUGZ_AGENT": "tunarr-alert-poll", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + str(Path.home() / "bin") + ":" + str(Path.home() / ".local/bin") + ":" + str(Path.home() / "life/bin"), "HOME": str(Path.home())})
    if p.returncode:
        sys.exit("bugz propose failed")
STATE.parent.mkdir(parents=True, exist_ok=True)
STATE.write_text(str(len(lines)))

# Weekly: summarise the box's diagnosis dumps (~/tunarr/dumps, written by
# tunarr-health.sh) into the slow-event-loop plan's bug note (Erik, 2026-11-05).
import time
WEEKLY = Path.home() / ".local/state/tunarr-dumps-weekly"
if time.time() - (float(WEEKLY.read_text()) if WEEKLY.exists() else 0) >= 7 * 86400:
    jq = ('[.[] | {ts, p99: .streams.loopP99Ms, m3u8: .streams.maxM3u8Lines, ch: (.worst.channel.number // "?"),'
          ' agent: ((.worst.agents // []) | map(select(. != null)) | join(",")), io: .streams.host.ioSomeAvg60}]'
          ' | "\\(length) dumps in 7 days; worst loop p99 \\(map(.p99) | max // 0) ms; worst m3u8 \\(map(.m3u8) | max // 0) lines;'
          ' by channel \\(group_by(.ch) | map("ch \\(.[0].ch) x\\(length)") | join(", "));'
          ' by agent \\(group_by(.agent) | map("\\(.[0].agent | if . == "" then "-" else . end) x\\(length)") | join(", "));'
          ' max host disk pressure \\(map(.io // 0) | max // 0)%"')
    cmd = f"cd ~/tunarr/dumps 2>/dev/null && find . -name '*.json' -mtime -7 -exec cat {{}} + | jq -rs '{jq}' || echo '0 dumps in 7 days'"
    w = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", BOX, cmd],
                       capture_output=True, text=True, timeout=120)
    summary = w.stdout.strip() or "0 dumps in 7 days"
    if w.returncode == 0:
        n = subprocess.run(["bugz", "note", "tunarr-slow-event-loop-capture-a-diagnosis-each-",
                            f"Weekly dump summary {time.strftime('%Y-%m-%d')}: {summary}"],
                           env={"BUGZ_AGENT": "tunarr-alert-poll", "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + str(Path.home() / ".local/bin"), "HOME": str(Path.home())})
        if n.returncode == 0:
            WEEKLY.write_text(str(time.time()))
