#!/usr/bin/env python3
"""Serve live streams (YouTube live, HLS, anything yt-dlp reads) as plain
MPEG-TS over HTTP so Tunarr's ffmpeg can use them as a channel input.

GET /<name> runs `yt-dlp -o - <url>` for streams.json[name] and pipes its
output to the client. yt-dlp does the fetching, so YouTube's short-lived,
IP-bound manifest URLs never reach ffmpeg. One yt-dlp per connection; it is
killed when the client disconnects.

Pair with TUNARR_LIVE_CHANNELS='{"14":"http://127.0.0.1:8210/lofi"}'.
"""
import json
import os
import shlex
import signal
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("LIVE_PROXY_PORT", "8210"))
# A command, not just a path: on the Whatbox this is `podman exec youtarr
# /opt/yt-dlp/yt-dlp` so yt-dlp can use the pod-private ProtonVPN SOCKS proxy.
YTDLP = shlex.split(os.environ.get("YTDLP", os.path.expanduser("~/.local/bin/yt-dlp")))
# Extra yt-dlp args, e.g. "-6 --cookies /path/cookies.txt"
EXTRA = shlex.split(os.environ.get("YTDLP_ARGS", ""))


def streams():
    with open(os.path.join(HERE, "streams.json")) as f:
        return json.load(f)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = streams().get(self.path.strip("/"))
        if not url:
            self.send_error(404)
            return
        # Remux to a fixed layout (video 0, audio 1): Tunarr maps streams by
        # the placeholder program's indices, and sources order them freely.
        cmd = (
            f"{shlex.join([*YTDLP, '-q', '--no-warnings', '--no-part', '-f', 'bv*[height<=720]+ba/b', '--downloader', 'ffmpeg', '--hls-use-mpegts', *EXTRA, '-o', '-', url])}"
            " | ffmpeg -nostdin -loglevel error -i - -map 0:v:0 -map 0:a:0 -c copy -f mpegts -"
        )
        proc = subprocess.Popen(
            ["bash", "-o", "pipefail", "-c", cmd],
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            start_new_session=True,  # own process group: kill yt-dlp + ffmpeg together
        )
        try:
            first = proc.stdout.read(188 * 64)
            if not first:
                self.send_error(502, "yt-dlp produced no data")
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.end_headers()
            self.wfile.write(first)
            while chunk := proc.stdout.read(65536):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
