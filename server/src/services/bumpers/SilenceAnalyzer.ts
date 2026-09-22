import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import { KEYS } from '@/types/inject.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { inject, injectable } from 'inversify';
import { spawn } from 'node:child_process';
import type { SilencePeriod } from './SilenceCache.js';
import { SilenceCache } from './SilenceCache.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'SilenceAnalyzer',
});

// Minimum noise floor for silence detection (-40 dB is a reasonable threshold
// for detecting true pauses in dialog/music without false-positives).
const SILENCE_NOISE_FLOOR = '-40dB';
// Minimum silence duration to be considered a break point (0.5 s).
const SILENCE_MIN_DURATION = '0.5';

@injectable()
export class SilenceAnalyzer {
  // Track in-progress analyses so we don't spawn duplicates
  private readonly inProgress = new Set<string>();

  constructor(
    @inject(KEYS.SettingsDB) private settingsDB: ISettingsDB,
    @inject(SilenceCache) private silenceCache: SilenceCache,
  ) {}

  /**
   * Returns cached silence periods for the file, or undefined if not yet
   * analyzed. Kicks off a background analysis job the first time a file is
   * requested so the result is available on the next play.
   *
   * Safe for shared VMs: runs at nice +19 with audio-only decode and a
   * single thread, so it won't compete with the live stream process.
   */
  async getSilences(filePath: string): Promise<SilencePeriod[] | undefined> {
    const cached = await this.silenceCache.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Queue background analysis (fire-and-forget)
    this.analyzeInBackground(filePath);
    return undefined;
  }

  private analyzeInBackground(filePath: string): void {
    if (this.inProgress.has(filePath)) return;
    this.inProgress.add(filePath);

    const ffmpegPath =
      this.settingsDB.ffmpegSettings().ffmpegExecutablePath ?? 'ffmpeg';

    // Run at lowest CPU priority; decode audio only with a single thread.
    const args = [
      '-n', '19',
      ffmpegPath,
      '-threads', '1',
      '-i', filePath,
      '-vn',
      '-af', `silencedetect=n=${SILENCE_NOISE_FLOOR}:d=${SILENCE_MIN_DURATION}`,
      '-f', 'null',
      '-',
    ];

    logger.debug('Starting background silence analysis for %s', filePath);

    const child = spawn('nice', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      logger.warn(
        { err },
        'Silence analysis process error for %s',
        filePath,
      );
      this.inProgress.delete(filePath);
    });

    child.on('close', (code) => {
      this.inProgress.delete(filePath);
      if (code !== 0) {
        logger.warn(
          'Silence analysis exited with code %s for %s',
          String(code),
          filePath,
        );
        return;
      }

      const silences = parseSilenceOutput(stderr);
      logger.debug(
        'Silence analysis complete: %d periods found in %s',
        silences.length,
        filePath,
      );

      this.silenceCache.set(filePath, silences).catch((err: unknown) => {
        logger.warn({ err }, 'Failed to store silence cache for %s', filePath);
      });
    });
  }
}

/**
 * Parses ffmpeg silencedetect stderr output into silence periods (in seconds).
 *
 * ffmpeg emits lines like:
 *   [silencedetect @ ...] silence_start: 1320.12
 *   [silencedetect @ ...] silence_end: 1322.45 | silence_duration: 2.33
 */
export function parseSilenceOutput(stderr: string): SilencePeriod[] {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const line of stderr.split('\n')) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    if (startMatch) {
      starts.push(parseFloat(startMatch[1]!));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    if (endMatch) {
      ends.push(parseFloat(endMatch[1]!));
    }
  }

  const periods: SilencePeriod[] = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    periods.push({ start: starts[i]!, end: ends[i]! });
  }
  // Handle a trailing silence that reaches end-of-file (no silence_end emitted)
  if (starts.length > ends.length) {
    periods.push({ start: starts[starts.length - 1]!, end: Infinity });
  }
  return periods;
}
