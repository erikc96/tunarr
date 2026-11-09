import { BaseHlsSession } from '@/stream/hls/BaseHlsSession.js';
import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import { transcodeCap } from '@/stream/qualityProfiles.js';
import { loopP99Ms, startLoopMonitor } from '@/util/loopMonitor.js';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import path from 'node:path';
import { globalOptions } from '@/globals.js';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function countLines(path: string) {
  try {
    return (await readFile(path, 'utf-8')).split('\n').length - 1;
  } catch {
    return null;
  }
}

/** Number of lines of `cmd args` stdout, or null where the command fails (non-Linux). */
async function countOutputLines(cmd: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 1 << 26 });
    return stdout.split('\n').filter((l) => l.trim().length > 0).length;
  } catch (e) {
    // pgrep exits 1 when nothing matches
    return (e as { code?: unknown }).code === 1 ? 0 : null;
  }
}

export const debugHealthApiRouter: RouterPluginAsyncCallback = async (
  fastify,
  // eslint-disable-next-line @typescript-eslint/require-await
) => {
  startLoopMonitor();

  // Samples the main thread's JS for `secs` seconds (in-process inspector, no
  // listening port) and writes <databaseDirectory>/profiles/<stamp>.cpuprofile.
  // Used to name what blocks the event loop when perf is unavailable.
  let profiling = false;
  fastify.post('/cpuprofile', async (req, res) => {
    const secs = Math.min(
      120,
      Math.max(1, Number((req.query as { secs?: string }).secs ?? 30)),
    );
    if (profiling) return res.status(409).send({ error: 'already profiling' });
    profiling = true;
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1000 });
    await session.post('Profiler.start');
    const dir = path.join(globalOptions().databaseDirectory, 'profiles');
    const file = path.join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`,
    );
    setTimeout(() => {
      void (async () => {
        try {
          const { profile } = await session.post('Profiler.stop');
          await mkdir(dir, { recursive: true });
          await writeFile(file, JSON.stringify(profile));
        } finally {
          session.disconnect();
          profiling = false;
        }
      })();
    }, secs * 1000);
    return res.send({ file, secs });
  });

  fastify.get('/streams', async (req, res) => {
    const user = os.userInfo().username;
    const [sessions, ffmpegProcs, threads] = await Promise.all([
      Promise.all(
        req.serverCtx.sessionManager.sessionInfos().map(async (info) => ({
          key: info.key,
          type: info.session.sessionType,
          ageMs: info.ageMs,
          connections: info.session.numConnections(),
          agents: Object.values(info.session.connections()).map(
            (c) => c.userAgent ?? null,
          ),
          idleForMs: info.idleForMs,
          m3u8Lines:
            info.session instanceof BaseHlsSession
              ? await countLines(info.session.m3uPlaylistPath)
              : null,
        })),
      ),
      countOutputLines('pgrep', ['-u', user, 'ffmpeg']),
      countOutputLines('ps', ['-u', user, '-L', '-o', 'lwp=']),
    ]);

    return res.send({
      loopP99Ms: loopP99Ms(),
      activeWeight: req.serverCtx.sessionManager.activeWeight(),
      reservedWeight: req.serverCtx.sessionManager.reservedWeight(),
      cap: transcodeCap(),
      viewerReserve: req.serverCtx.sessionManager.viewerReserve(),
      probeRejected: req.serverCtx.sessionManager.probeRejected(),
      ffmpegProcs,
      userThreads: threads,
      sessionCount: sessions.length,
      maxSessionAgeMs: Math.max(0, ...sessions.map((s) => s.ageMs)),
      maxM3u8Lines: Math.max(0, ...sessions.map((s) => s.m3u8Lines ?? 0)),
      sessions,
    });
  });
};
