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
