import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { IProgramDB } from '@/db/interfaces/IProgramDB.js';
import type { DrizzleDBAccess } from '@/db/schema/index.js';
import { KEYS } from '@/types/inject.js';
import { fileExists } from '@/util/fsUtil.js';
import { isNonEmptyString } from '@/util/index.js';
import { inject, injectable } from 'inversify';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { PathCalculator } from '../../stream/PathCalculator.ts';
import { ActBreakCache, type ActBreakCacheEntry } from './ActBreakCache.js';

export type Interval = { start: number; end: number };
export type ActBreakResult =
  | Pick<
      ActBreakCacheEntry,
      'status' | 'durationMs' | 'chaptersMs' | 'strongMs' | 'weakMs' | 'error'
    >
  | { status: 'pending' }
  | { status: 'failed'; error: string };

export function parseFfprobeOutput(output: string): {
  durationMs: number;
  chaptersMs: number[];
} {
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object')
    return { durationMs: 0, chaptersMs: [] };
  const record = value as {
    format?: { duration?: string };
    chapters?: { start_time?: string }[];
  };
  return {
    durationMs: Math.round(Number(record.format?.duration ?? 0) * 1000),
    chaptersMs: (record.chapters ?? [])
      .map((c) => Math.round(Number(c.start_time ?? 0) * 1000))
      .filter(Number.isFinite),
  };
}

export function parseDetectionOutput(stderr: string): {
  blacks: Interval[];
  silences: Interval[];
} {
  const blacks: Interval[] = [];
  const silences: Interval[] = [];
  let silenceStart: number | undefined;
  for (const line of stderr.split('\n')) {
    const black = line.match(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/);
    if (black) blacks.push({ start: Number(black[1]), end: Number(black[2]) });
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) silenceStart = Number(start[1]);
    const end = line.match(
      /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/,
    );
    if (end && silenceStart !== undefined) {
      silences.push({ start: silenceStart, end: Number(end[1]) });
      silenceStart = undefined;
    }
  }
  return { blacks, silences };
}

export function deriveActBreakCandidates(
  durationMs: number,
  chaptersMs: number[],
  blacks: Interval[],
  silences: Interval[],
) {
  const valid = (ms: number) => ms > 60_000 && ms < durationMs - 60_000;
  const unique = (values: number[]) =>
    values
      .sort((a, b) => a - b)
      .filter(
        (value, index, all) => index === 0 || value - all[index - 1]! > 2_000,
      );
  const strong = unique(
    blacks
      .flatMap((black) =>
        silences.flatMap((silence) => {
          const start = Math.max(black.start, silence.start);
          const end = Math.min(black.end, silence.end);
          return end >= start ? [Math.round(((start + end) / 2) * 1000)] : [];
        }),
      )
      .filter(valid),
  );
  const weak = unique(
    silences
      .filter((silence) => silence.end - silence.start >= 1)
      .map((silence) => Math.round(((silence.start + silence.end) / 2) * 1000))
      .filter(
        (point) =>
          valid(point) && !strong.some((s) => Math.abs(s - point) <= 2_000),
      ),
  );
  return {
    chaptersMs: unique(chaptersMs.filter(valid)),
    strongMs: strong,
    weakMs: weak,
  };
}

@injectable()
export class ActBreakAnalyzer {
  private running = false;
  private readonly queued = new Set<string>();
  private readonly queue: string[] = [];

  constructor(
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
    @inject(KEYS.ProgramDB) private programDB: IProgramDB,
    @inject(KEYS.DrizzleDB) private drizzle: DrizzleDBAccess,
    @inject(ActBreakCache) private cache: ActBreakCache,
  ) {}

  async get(programId: string): Promise<ActBreakResult> {
    // The czar asks for a whole channel every hour: answer from the cache
    // with one stat() and no program lookup when the file hasn't changed.
    const hit = await this.cache.get(programId);
    if (hit?.status === 'ready' && isNonEmptyString(hit.path)) {
      const size = await stat(hit.path).then(
        (f) => f.size,
        () => undefined,
      );
      if (size === hit.size) return hit;
    }
    const filePath = await this.resolveFilePath(programId);
    if (!filePath) {
      const program = await this.programDB.getProgramById(programId);
      if (!program) return { status: 'failed', error: 'unknown program' };
      await this.cache.set(programId, emptyFailure('', 0, 'no local file'));
      return { status: 'failed', error: 'no local file' };
    }
    const file = await stat(filePath);
    const cached = await this.cache.get(programId);
    const failedRecently =
      cached?.status === 'failed' &&
      Date.now() - Date.parse(cached.analyzedAt) < 24 * 60 * 60 * 1000;
    if (
      cached &&
      cached.path === filePath &&
      cached.size === file.size &&
      (cached.status === 'ready' || failedRecently)
    )
      return cached;
    this.enqueue(programId);
    return { status: 'pending' };
  }

  private enqueue(id: string) {
    if (!this.queued.has(id)) {
      this.queued.add(id);
      this.queue.push(id);
      void this.drain();
    }
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      await this.analyze(id).catch((error: unknown) =>
        this.cache.set(
          id,
          emptyFailure(
            '',
            0,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    }
    this.running = false;
  }

  private async analyze(programId: string) {
    const filePath = await this.resolveFilePath(programId);
    if (!filePath) {
      await this.cache.set(programId, emptyFailure('', 0, 'no local file'));
      return;
    }
    const file = await stat(filePath);
    try {
      const settings = this.settingsDB.ffmpegSettings();
      const ffmpeg = settings.ffmpegExecutablePath ?? 'ffmpeg';
      const ffprobe =
        settings.ffprobeExecutablePath ||
        path.join(path.dirname(ffmpeg), 'ffprobe');
      const probe = await run('nice', [
        '-n',
        '19',
        ffprobe,
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_chapters',
        '-show_format',
        filePath,
      ]);
      const parsed = parseFfprobeOutput(probe.stdout);
      const detect = await run('nice', [
        '-n',
        '19',
        ffmpeg,
        '-hide_banner',
        '-nostats',
        '-threads',
        '2',
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        'fps=5,scale=160:-2,blackdetect=d=0.2:pix_th=0.10',
        '-af',
        'silencedetect=n=-45dB:d=0.4',
        '-f',
        'null',
        '-',
      ]);
      if (detect.code !== 0)
        throw new Error(detect.stderr || `ffmpeg exited ${detect.code}`);
      const periods = parseDetectionOutput(detect.stderr);
      await this.cache.set(programId, {
        path: filePath,
        size: file.size,
        analyzedAt: new Date().toISOString(),
        status: 'ready',
        durationMs: parsed.durationMs,
        ...deriveActBreakCandidates(
          parsed.durationMs,
          parsed.chaptersMs,
          periods.blacks,
          periods.silences,
        ),
      });
    } catch (error) {
      await this.cache.set(
        programId,
        emptyFailure(
          filePath,
          file.size,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async resolveFilePath(programId: string) {
    const program = await this.programDB.getProgramById(programId);
    if (!program) return undefined;
    const local = program.versions
      ?.flatMap((version) => version.mediaFiles ?? [])
      .at(0)?.path;
    if (isNonEmptyString(local) && (await fileExists(local))) return local;
    const direct = program.externalIds?.find((id) =>
      isNonEmptyString(id.directFilePath),
    )?.directFilePath;
    if (!isNonEmptyString(direct)) return undefined;
    if (await fileExists(direct)) return direct;
    const mediaSourceId = program.mediaSourceId;
    if (!mediaSourceId) return undefined;
    const source = await this.drizzle.query.mediaSource.findFirst({
      where: (fields, { eq }) => eq(fields.uuid, mediaSourceId),
      with: { replacePaths: true },
    });
    return source
      ? PathCalculator.findFirstValidPath(direct, source.replacePaths)
      : undefined;
  }
}

function emptyFailure(
  path: string,
  size: number,
  error: string,
): ActBreakCacheEntry {
  return {
    path,
    size,
    analyzedAt: new Date().toISOString(),
    status: 'failed',
    durationMs: 0,
    chaptersMs: [],
    strongMs: [],
    weakMs: [],
    error,
  };
}
function run(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
