# erikc96/tunarr: what this fork adds

This is a personal fork of [Tunarr](https://github.com/chrisbenincasa/tunarr). The upstream [README](README.md) covers Tunarr itself. The fork's work is on the `feat/ai-assistant` branch, and that branch is what runs on my own server. It isn't packaged or released. If you want any of it, build from source the same way as upstream.

## Stream quality profiles (`?quality=low|fire`)

`GET /stream/channels/<n>.ts` takes an optional `quality` parameter. Without it, the stream is upstream's: the channel's HLS output wrapped as one MPEG-TS stream, copied, not re-encoded. With it, the wrapper re-encodes:

| `quality` | Video | Audio | For |
|---|---|---|---|
| `low` | up to 854×480, 1200 kbps | AAC 96 kbps | slow connections; the web player drops to it after repeated stalls |
| `fire` | up to 1280×720, 3000 kbps | AAC 128 kbps | the Amazon Fire TV Stick web player (below) |

Both profiles force 8-bit 4:2:0 (`yuv420p`), so 10-bit sources play on decoders that only handle 8-bit. They also add `-tune zerolatency` and stereo audio, and put a keyframe every second (`-force_key_frames expr:gte(t,n_forced*1)`). A viewer who joins mid-stream then gets a picture within about half a second.

Start-up tuning on this branch:

- The wrapper reads its input with a 4 s initial burst (`-readrate 1 -readrate_initial_burst 4`), for all qualities. A 30 s burst was tried and reverted, because it made the output arrive in clumps every few seconds.
- HLS segments are 2 s instead of upstream's 4 s.
- The session the Fire/low wrapper reads from starts after one segment (`initialSegmentCount: 1`). Upstream waits for two.

### Why a `fire` profile

Since an Amazon WebView update in October 2026, the Fire TV Stick's WebView (Chromium 148, in Fully Kiosk Browser) decodes `<video>` but draws a white or black picture. The [craigo.art/tv](https://craigo.art/tv) player therefore skips `<video>` on the stick. It demuxes this MPEG-TS stream in the page, decodes it with WebCodecs onto a `<canvas>`, and plays the audio through WebAudio. The stick decodes in software, so it gets a fixed 8-bit 720p stream with frequent keyframes. Fully Kiosk's native player (`fully.playVideo`) is the fallback, and it plays the same `?quality=fire` URL.

## Other fork features

- **AI assistant for channel curation** (Anthropic API): build or refresh a channel from a plain-language prompt, a chat interface, recommendations, scheduled lineup top-ups, and a settings page.
- **Live channels**: `TUNARR_LIVE_CHANNELS='{"14":"http://127.0.0.1:8210/lofi"}'` maps a channel number to a live MPEG-TS URL. The scheduled program stays in the guide as a placeholder, and ffmpeg plays the live URL from its live edge. `scripts/live-proxy/` serves any yt-dlp-readable live stream (YouTube live, HLS) as MPEG-TS on localhost, so short-lived YouTube manifest URLs never reach ffmpeg.
- **Bumper packs, block scheduling and round-time snap** for filler between programs; bumper media sources and silence-aware bumpers.
- Fixes: external subtitle cache keyed by stream URL; Plex deep links; the ffmpeg video preset flag.
- A Bauhaus MUI theme for the web UI.

## Keeping in sync with upstream

This branch carries upstream history. Merge `chrisbenincasa/tunarr` `main` into it to update, and keep fork-only docs in this file, so upstream's README merges cleanly.
