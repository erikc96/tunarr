import { BaseHlsSession } from '@/stream/hls/BaseHlsSession.js';
import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import { loopP99Ms, startLoopMonitor } from '@/util/loopMonitor.js';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  } catch {
    return null;
  }
}

export const debugHealthApiRouter: RouterPluginAsyncCallback = async (
  fastify,
  // eslint-disable-next-line @typescript-eslint/require-await
) => {
  startLoopMonitor();

  fastify.get('/streams', async (req, res) => {
    const user = os.userInfo().username;
    const [sessions, ffmpegProcs, threads] = await Promise.all([
      Promise.all(
        req.serverCtx.sessionManager.sessionInfos().map(async (info) => ({
          key: info.key,
          type: info.session.sessionType,
          ageMs: info.ageMs,
          connections: info.session.numConnections(),
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
      ffmpegProcs,
      userThreads: threads,
      sessionCount: sessions.length,
      maxSessionAgeMs: Math.max(0, ...sessions.map((s) => s.ageMs)),
      maxM3u8Lines: Math.max(0, ...sessions.map((s) => s.m3u8Lines ?? 0)),
      sessions,
    });
  });
};
