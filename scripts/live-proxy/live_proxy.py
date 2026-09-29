#!/usr/bin/env python3
"""Serve live streams (YouTube live, HLS, anything yt-dlp reads) as plain
MPEG-TS over HTTP so Tunarr's ffmpeg can use them as a channel input.

GET /<name> runs `yt-dlp -o - <url>` for streams.json[name] and pipes its
output to the client. yt-dlp does the fetching, so YouTube's short-lived,
IP-bound manifest URLs never reach ffmpeg. One yt-dlp per connection; it is
killed when the client disconnects, when no data arrives within STALL seconds,
or when the stream stalls that long. yt-dlp under `podman exec` is a child of
conmon, not ours, so each run is tagged (-P temp:/tmp/lp-<id>) and killed by tag:
a hung yt-dlp otherwise lives forever, and every Tunarr retry adds another.

If YTDLP_ARGS has `--proxy socks5://...`, yt-dlp gets this server as an HTTP
proxy instead (CONNECT, YouTube hosts only, per-run token), and we forward to
that SOCKS proxy. Two reasons: yt-dlp passes an HTTP proxy on to its ffmpeg
downloader but not a SOCKS one, so with SOCKS the IP-bound HLS segments went
out direct and got 403; and yt-dlp treats socks5:// as socks5h://, while
wireproxy's remote DNS times out for manifest.googlevideo.com. We resolve
locally and send the SOCKS proxy an IP.

Pair with TUNARR_LIVE_CHANNELS='{"14":"http://127.0.0.1:8210/lofi"}'.
"""
import base64
import json
import os
import re
import secrets
import select
import shlex
import signal
import socket
import subprocess
import sys
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("LIVE_PROXY_PORT", "8210"))
# A command, not just a path: on the Whatbox this is `podman exec youtarr
# /opt/yt-dlp/yt-dlp` so yt-dlp can use the pod-private ProtonVPN SOCKS proxy.
YTDLP = shlex.split(os.environ.get("YTDLP", os.path.expanduser("~/.local/bin/yt-dlp")))
# Extra yt-dlp args, e.g. "-6 --cookies /path/cookies.txt"
EXTRA = shlex.split(os.environ.get("YTDLP_ARGS", ""))
STALL = int(os.environ.get("LIVE_PROXY_STALL", "30"))
# Where the SOCKS proxy from YTDLP_ARGS listens as seen from this host (the
# URL's own host is the pod's alias for our loopback, 169.254.1.3).
SOCKS_HOST = os.environ.get("LIVE_PROXY_SOCKS_HOST", "127.0.0.1")
ALLOWED = re.compile(r"(^|\.)(youtube\.com|googlevideo\.com|google\.com|googleapis\.com|ytimg\.com|ggpht\.com)$")
TOKEN = secrets.token_urlsafe(16)
AUTH = "Basic " + base64.b64encode(f"lp:{TOKEN}".encode()).decode()
UPSTREAM = None
if "--proxy" in EXTRA:
    i = EXTRA.index("--proxy") + 1
    u = urllib.parse.urlsplit(EXTRA[i])
    if u.scheme in ("socks5", "socks5h"):
        UPSTREAM = u
        EXTRA[i] = f"http://lp:{TOKEN}@{u.hostname}:{PORT}"


def streams():
    with open(os.path.join(HERE, "streams.json")) as f:
        return json.load(f)


class Handler(BaseHTTPRequestHandler):
    def do_CONNECT(self):
        host, _, port = self.path.rpartition(":")
        if not (UPSTREAM and ALLOWED.search(host)):
            self.send_error(403)
            return
        if self.headers.get("Proxy-Authorization") != AUTH:
            # ffmpeg only sends credentials after a challenge
            self.send_response(407)
            self.send_header("Proxy-Authenticate", 'Basic realm="live-proxy"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            up = socks_connect(host, int(port))
        except (OSError, ValueError) as e:
            self.send_error(502, str(e))
            return
        self.send_response(200)
        self.end_headers()
        self.close_connection = True
        with up:
            relay(self.connection, up)

    def do_GET(self):
        url = streams().get(self.path.strip("/"))
        if not url:
            self.send_error(404)
            return
        # Remux to a fixed layout (video 0, audio 1): Tunarr maps streams by
        # the placeholder program's indices, and sources order them freely.
        tag = f"lp-{uuid.uuid4().hex[:12]}"
        cmd = (
            f"{shlex.join([*YTDLP, '-P', f'temp:/tmp/{tag}', '-q', '--no-warnings', '--no-part', '-f', 'bv*[height<=720]+ba/b', '--downloader', 'ffmpeg', '--hls-use-mpegts', *EXTRA, '-o', '-', url])}"
            " | ffmpeg -nostdin -loglevel error -i - -map 0:v:0 -map 0:a:0 -c copy -f mpegts -"
        )
        proc = subprocess.Popen(
            ["bash", "-o", "pipefail", "-c", cmd],
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            start_new_session=True,  # own process group: kill yt-dlp + ffmpeg together
        )
        try:
            first = read(proc, 188 * 64)
            if not first:
                self.send_error(502, "yt-dlp produced no data")
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.end_headers()
            self.wfile.write(first)
            while chunk := read(proc, 65536):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            subprocess.run(["pkill", "-KILL", "-u", str(os.getuid()), "-f", tag])


def socks_connect(host, port):
    """A socket to host:port through UPSTREAM (SOCKS5), resolved here, not there."""
    ip = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    s = socket.create_connection((SOCKS_HOST, UPSTREAM.port), timeout=20)
    try:
        user = urllib.parse.unquote(UPSTREAM.username or "").encode()
        pw = urllib.parse.unquote(UPSTREAM.password or "").encode()
        s.sendall(b"\x05\x01" + (b"\x02" if user else b"\x00"))
        method = recvn(s, 2)[1]
        if method == 2:
            s.sendall(b"\x01" + bytes([len(user)]) + user + bytes([len(pw)]) + pw)
            if recvn(s, 2)[1] != 0:
                raise OSError("socks auth failed")
        elif method != 0:
            raise OSError("socks auth method refused")
        s.sendall(b"\x05\x01\x00\x01" + socket.inet_aton(ip) + port.to_bytes(2, "big"))
        rep = recvn(s, 4)
        if rep[1] != 0:
            raise OSError(f"socks connect to {host} failed ({rep[1]})")
        atyp = rep[3]
        recvn(s, (4 if atyp == 1 else 16 if atyp == 4 else recvn(s, 1)[0]) + 2)  # bound address
        s.settimeout(None)
        return s
    except BaseException:
        s.close()
        raise


def recvn(s, n):
    buf = b""
    while len(buf) < n:
        if not (chunk := s.recv(n - len(buf))):
            raise OSError("socks proxy closed the connection")
        buf += chunk
    return buf


def relay(a, b):
    """Copy bytes both ways until either side closes or 5 min of silence."""
    try:
        while r := select.select([a, b], [], [], 300)[0]:
            for s in r:
                if not (data := s.recv(65536)):
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass


def read(proc, n):
    """Up to n bytes from proc's stdout, or b"" after STALL seconds without data."""
    if not select.select([proc.stdout], [], [], STALL)[0]:
        return b""
    return os.read(proc.stdout.fileno(), n)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
