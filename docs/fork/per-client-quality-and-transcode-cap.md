# Per-client quality profiles, device admin page, and a transcode cap

Design only, no code yet. Written 2026-10-26 for the Craigotv fork. I searched the repo and `~/notes/projects` for an earlier device or admin-page plan and found none, so this is the first one.

## What Erik decided

- The global default stays as it is. Quality is chosen per client: PiP gets 720p, full-screen browser gets 1080p, and named devices (several Roku boxes on CRT TVs) get 480p.
- The devices are set up on an admin page.
- The Fire stick keeps its own second re-encode (`?quality=fire`).

## What the code does today

- A channel has one shared HLS transcode, made from the channel's transcode config. The `.ts` route wraps it. `?quality=low|fire` adds a second ffmpeg that re-encodes the wrapper's output (`streamApi.ts` `concatSessionTypeForQuality`, session types `hls_concat_low` and `hls_concat_fire`).
- So a 480p viewer today costs the full 1080p transcode plus a 480p re-encode. Serving Rokus as "low" does not save the expensive part.
- Clients are not identified. `StreamConnectionDetails` holds only `ip` and `userAgent`.

## Picking a profile for a request

First match wins:

1. `?device=<slug>` in the stream URL, matched to a device row. This is the reliable one for Roku IPTV apps, where the URL is typed in once.
2. A device rule on source IP or CIDR, or on a user-agent regex. This catches clients whose URL cannot be changed.
3. `?size=pip|full` from the craigo.art player (PiP maps to 720p, full to 1080p). The player change lives in the other repo.
4. The existing `?quality=` value, then the channel's own config. That is today's behaviour, so nothing changes for an unlabelled client.

## Data model

Two Drizzle tables, with a migration from `pnpm drizzle-kit generate`.

- `quality_profile`: id, name, maxHeight, videoKbps, audioKbps, fps cap, `weight` (transcode cost, below). Built-in rows: `480p`, `720p`, `1080p`, `fire` (the current fire wrapper, unchanged).
- `client_device`: id, slug, name, profileId, optional `ipCidr`, optional `uaRegex`, notes, `lastSeenAt`, `lastIp`, `lastUserAgent`.

## Where the transcode happens

Two ways to serve 480p, and they cost differently.

- **A. Wrapper re-encode** (what `low` does). Cost per 480p viewer: the channel's base transcode plus a 480p encode. No new session type.
- **B. One transcode per (channel, profile).** An `hls` session is keyed by channel and profile, so a 480p viewer gets a transcode made at 480p straight from the source. No double encode, and no 1080p transcode if nobody needs one.

Recommendation: B for `480p` and `720p`, with `1080p` being the current `hls` session. Fire stays on A as decided. The cost is that one channel watched at two profiles runs two transcodes, which the cap below handles. The change is in `SessionManager`: widen the session key to include the profile, and pass the profile's ffmpeg limits into the HLS session options.

## Transcode cap and the 503

- New ffmpeg setting `maxActiveTranscodes`, start at 16, counted as profile weight (1080p = 1, 720p = 0.5, 480p = 0.25, so the cap really is a CPU budget). Fire's second encode counts 0.5 on top of its base.
- Only starting a new transcode is checked. Joining a session that already runs is always allowed.
- Order of work when a start would pass the cap: evict idle lingering sessions, oldest first (the existing `evictLingeringSessions` path), then re-check, then refuse.
- Refusal is `503` with `Retry-After: 5` and JSON `{ busy: true, active, cap }`. Roku IPTV apps retry on a 503 by themselves. The craigo.art player shows a "channel is busy, retrying" screen (player change in the other repo).
- The check runs under the existing per-channel lock, plus one small global mutex around the counter so two channels cannot both take the last slot.
- `/api/debug/streams` gains `activeWeight` and `cap`, so the health cron can watch it.

### Viewer reserve for probe traffic

Probe-like requests must not consume the last transcode capacity needed by real viewers. `TUNARR_VIEWER_RESERVE` is a numeric reserve in transcode-weight units, defaulting to `2`. A request is probe-class when its user agent is empty or one of the common command-line clients (`curl`, `wget`, `python`, or `Go-http-client`), or when it has `?probe=1`, or a byte range beginning at zero with an end no greater than 1 MB. Internal `Lavf`/`Tunarr` requests and browsers/players remain normal viewers.

Probe-class requests may join an existing session. When they would start one, admission requires `activeWeight + reservedWeight + newWeight <= cap - reserve`; otherwise the request receives the existing busy body with `reason: "probe-reserve"`, `Retry-After: 30`, and the rejection is counted in `/api/debug/streams`. `TUNARR_VIEWER_RESERVE=0` disables this guard. Normal viewers retain the existing cap behavior.

## Admin page

A new route `web/src/routes/settings/devices`, in the Settings menu.

- **Devices**: table of name, slug, profile, match rules, last seen. Add, edit, delete.
- **Recent clients**: IP and user agent seen in the last day, with a one-click "make this a device". This is how a Roku gets named without typing its IP or UA. It needs a small in-memory "recent clients" ring in `ConnectionTracker`.
- **Profiles**: edit the numbers of the built-in profiles and add new ones.
- **Copy URL** button per device: `https://…/stream/channels/<n>.ts?device=<slug>`.

API: `GET/POST/PUT/DELETE /api/client-devices` and `/api/quality-profiles`, then `pnpm generate-openapi` and `pnpm generate-client`.

## Build order

1. Profile resolver (pure function, vitest for the four-step precedence) and the two tables.
2. Profile-keyed `hls` sessions (B) behind the resolver. Vitest: two profiles on one channel get two sessions, one profile reuses one.
3. Transcode cap and 503. Vitest: cap reached, idle evicted first, join allowed at cap, 503 shape.
4. API, then admin page.
5. craigo.art player: send `?size=` and handle the busy screen.

Steps 1 to 3 can ship before the page exists; devices are then created with `curl`.

## Open questions for Erik

- How do the Roku boxes reach Tunarr today: an IPTV app with an M3U/HDHomeRun URL, or Plex? That decides whether `?device=` in the URL is possible or whether they need an IP rule.
- Are 480p Rokus on fixed IPs (DHCP reservations)? If so, the IP rule is enough and the `?device=` URLs are optional.
- Is a weight of 0.25 for 480p right, or should the cap just count sessions?
