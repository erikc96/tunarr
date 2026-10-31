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

One upstream pipeline per stream name is shared by every client and stays
warm LIVE_PROXY_LINGER seconds after the last client leaves; a new client
attaches at the newest keyframe in the pipeline's buffer, so a re-tune inside the
linger starts at once. A cold start skips yt-dlp's slow extraction: the
resolved media URLs are cached (INFO_TTL) and ffmpeg reads them directly,
through this server as an HTTP proxy for YouTube hosts. If that path yields
no data, the cache entry is dropped and the old `yt-dlp | ffmpeg` pipe runs.
Sources with no audio get a silent AAC track, so every stream is video 0, audio 1.

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
import threading
import time
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
LINGER = int(os.environ.get("LIVE_PROXY_LINGER", "120"))
INFO_TTL = int(os.environ.get("LIVE_PROXY_INFO_TTL", "3600"))
BUF_MAX = 16 << 20
CHUNK = 188 * 348  # TS packets per write, ~64 KB
YT = r"youtube\.com|googlevideo\.com|google\.com|googleapis\.com|ytimg\.com|ggpht\.com"
YT_HOST = re.compile(rf"(^|\.)({YT})$")
# EarthCam is reachable direct from the box, so ffmpeg does not use the VPN for
# it; CONNECT allows it in case that changes.
ALLOWED = re.compile(rf"(^|\.)({YT}|earthcam\.com)$")
# Extra HTTP headers per host (ffmpeg -headers); EarthCam 403s without a Referer.
HEADERS = [(re.compile(r"(^|\.)earthcam\.com$"), "Referer: https://www.earthcam.com/\r\n")]
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
        name = self.path.strip("/")
        url = streams().get(name)
        if not url:
            self.send_error(404)
            return
        for _ in range(3):
            p = pipeline(name, url)
            if p.attach():
                break
        else:
            self.send_error(503)
            return
        try:
            pos = p.start_pos()
            if pos is None:
                self.send_error(502, "no data from upstream")
                return
            pos, head = pos
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.end_headers()
            self.wfile.write(head)
            while data := p.read(pos):
                self.wfile.write(data)
                pos += len(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            p.detach()


PIPES = {}
PIPES_LOCK = threading.Lock()
INFO = {}  # name -> (time, inputs, has_audio)


def pipeline(name, url):
    with PIPES_LOCK:
        p = PIPES.get(name)
        if not p or p.dead or p.stopping:
            p = PIPES[name] = Pipeline(name, url)
        return p


def host_of(url):
    return urllib.parse.urlsplit(url).hostname or ""


def in_opts(url):
    """ffmpeg input options for url: per-host headers, and the VPN for YouTube."""
    o = []
    for rx, h in HEADERS:
        if rx.search(host_of(url)):
            o += ["-headers", h]
    if UPSTREAM and YT_HOST.search(host_of(url)):
        o += ["-http_proxy", f"http://lp:{TOKEN}@127.0.0.1:{PORT}"]
    return o


def resolve(name, url):
    """(media URLs, has_audio) for a stream, cached INFO_TTL seconds."""
    hit = INFO.get(name)
    if hit and time.time() - hit[0] < INFO_TTL:
        return hit[1], hit[2]
    if YT_HOST.search(host_of(url)):
        out = subprocess.run(
            [*YTDLP, "-q", "--no-warnings", "-f", "bv*[height<=720]+ba/b", *EXTRA, "-g", url],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout.split()
    else:
        out = [url]
    if not out:
        raise OSError("no media URL")
    has_audio = len(out) > 1 or bool(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
         "-of", "csv=p=0", *in_opts(out[0]), out[0]],
        capture_output=True, text=True, timeout=30,
    ).stdout.strip())
    INFO[name] = (time.time(), out, has_audio)
    return out, has_audio


def direct_cmd(name, url):
    inputs, has_audio = resolve(name, url)
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error"]
    for u in inputs:
        cmd += [*in_opts(u), "-i", u]
    if len(inputs) > 1:
        cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy"]
    elif has_audio:
        cmd += ["-map", "0:v:0", "-map", "0:a:0", "-c", "copy"]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", "-shortest"]
    return cmd + ["-f", "mpegts", "-"], None


def legacy_cmd(name, url):
    # Remux to a fixed layout (video 0, audio 1): Tunarr maps streams by
    # the placeholder program's indices, and sources order them freely.
    tag = f"lp-{uuid.uuid4().hex[:12]}"
    return (
        f"{shlex.join([*YTDLP, '-P', f'temp:/tmp/{tag}', '-q', '--no-warnings', '--no-part', '-f', 'bv*[height<=720]+ba/b', '--downloader', 'ffmpeg', '--hls-use-mpegts', *EXTRA, '-o', '-', url])}"
        " | ffmpeg -nostdin -loglevel error -i - -map 0:v:0 -map 0:a:0 -c copy -f mpegts -"
    ), tag


class Pipeline:
    """One upstream process per stream, fanned out to any number of clients."""

    def __init__(self, name, url):
        self.name, self.url = name, url
        self.cond = threading.Condition()
        self.buf, self.base = bytearray(), 0  # buf[0] is absolute offset base
        self.keys = []  # (absolute offset of a video keyframe packet, PAT+PMT before it)
        self.pat = self.pmt = b""
        self.pmt_pid = self.pcr_pid = None
        self.clients, self.idle = 0, time.monotonic()
        self.ready = self.dead = self.stopping = False
        threading.Thread(target=self.run, daemon=True).start()

    def attach(self):
        with self.cond:
            if self.dead or self.stopping:
                return False
            self.clients += 1
            return True

    def detach(self):
        with self.cond:
            self.clients -= 1
            self.idle = time.monotonic()

    def start_pos(self):
        """(position, PAT+PMT to send first) once data exists, else None."""
        with self.cond:
            self.cond.wait_for(lambda: self.ready or self.dead, timeout=60)
            if not self.ready:
                return None
            return self.keys[-1] if self.keys else (self.base, b"")

    def read(self, pos):
        """Up to CHUNK bytes at pos; b"" at end of stream or if the client fell behind."""
        with self.cond:
            while True:
                end = self.base + len(self.buf)
                if pos < self.base:
                    return b""
                if pos < end:
                    return bytes(self.buf[pos - self.base:pos - self.base + CHUNK])
                if self.dead:
                    return b""
                self.cond.wait(5)

    def feed(self, data):
        with self.cond:
            for i in range(0, len(data), 188):
                pkt = data[i:i + 188]
                pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
                if pid == 0 and pkt[1] & 0x40:
                    self.pat = bytes(pkt)
                    o = 5 + pkt[4] + 8
                    if pkt[o:o + 2] != b"\x00\x00":
                        self.pmt_pid = ((pkt[o + 2] & 0x1F) << 8) | pkt[o + 3]
                elif pid == self.pmt_pid and pkt[1] & 0x40:
                    self.pmt = bytes(pkt)
                    o = 5 + pkt[4] + 8
                    self.pcr_pid = ((pkt[o] & 0x1F) << 8) | pkt[o + 1]  # the video PID
                elif pid == self.pcr_pid and pkt[3] & 0x20 and pkt[4] and pkt[5] & 0x40:  # random access: a keyframe
                    self.keys.append((self.base + len(self.buf) + i, self.pat + self.pmt))
            self.buf += data
            if len(self.buf) > BUF_MAX:
                cut = (len(self.buf) - BUF_MAX // 2) // 188 * 188
                del self.buf[:cut]
                self.base += cut
                self.keys = [k for k in self.keys if k[0] >= self.base]
            self.ready = True
            self.cond.notify_all()

    def run(self):
        try:
            builds = [direct_cmd] + ([legacy_cmd] if YT_HOST.search(host_of(self.url)) else [])
            for build in builds:
                try:
                    cmd, tag = build(self.name, self.url)
                except (OSError, subprocess.SubprocessError) as e:
                    print(f"{self.name}: {build.__name__} failed: {e}", file=sys.stderr, flush=True)
                    INFO.pop(self.name, None)
                    continue
                print(f"{self.name}: start {build.__name__}", file=sys.stderr, flush=True)
                if self.pump(cmd, tag):
                    break
                INFO.pop(self.name, None)
        finally:
            with self.cond:
                self.dead = True
                self.cond.notify_all()
            with PIPES_LOCK:
                if PIPES.get(self.name) is self:
                    del PIPES[self.name]

    def pump(self, cmd, tag):
        """Run cmd and feed its output until it ends, stalls or idles out.
        True if it produced any data."""
        proc = subprocess.Popen(
            cmd if tag is None else ["bash", "-o", "pipefail", "-c", cmd],
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            start_new_session=True,  # own process group: kill yt-dlp + ffmpeg together
        )
        got, rem, last = False, b"", time.monotonic()
        try:
            while True:
                if select.select([proc.stdout], [], [], 5)[0]:
                    data = os.read(proc.stdout.fileno(), CHUNK)
                    if not data:
                        break
                    data = rem + data
                    n = len(data) // 188 * 188
                    rem = data[n:]
                    if n:
                        self.feed(data[:n])
                        got, last = True, time.monotonic()
                now = time.monotonic()
                if now - last > (STALL if got else 20):
                    break
                with self.cond:
                    if self.clients == 0 and now - self.idle > LINGER:
                        self.stopping = True
                        got = True  # a clean stop, not a failure
                        break
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            if tag:
                subprocess.run(["pkill", "-KILL", "-u", str(os.getuid()), "-f", tag])
        return got


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


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
