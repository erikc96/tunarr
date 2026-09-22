import type { SilencePeriod } from '../services/bumpers/SilenceCache.ts';
import type { WithinBumperSegment } from '../db/derived_types/StreamLineup.ts';

// Don't insert a bumper within the first 60 seconds of the program, even if
// silence is detected there (e.g. brief pre-title silence).
const MIN_LEAD_MS = 60_000;

// How far from the target interval we're willing to snap to a silence period.
const SILENCE_SNAP_TOLERANCE_MS = 2 * 60_000;

export type PrependBumper = {
  path: string;
  durationMs: number;
  /** How far into the bumper we are when the stream starts (for late-tuning). */
  startOffset: number;
};

/**
 * Builds an ffconcat file that optionally prepends a between-program bumper
 * and/or interleaves within-program bumpers.
 *
 * - `prependBumper`: plays at the very start of the slot (between-program).
 *   If the viewer tunes in partway through it, `startOffset` skips ahead.
 * - `withinBumpers`: interleaved into the show content at `intervalMs` boundaries.
 *
 * The total duration of the generated concat equals `streamDurationMs`.
 */
export function buildBumperConcat(
  showPath: string,
  programDurationMs: number,
  showStartMs: number,
  streamDurationMs: number,
  options: {
    prependBumper?: PrependBumper;
    withinBumpers?: WithinBumperSegment;
  },
  silences?: SilencePeriod[],
): string {
  const lines: string[] = ['ffconcat version 1.0'];
  let outputRemaining = streamDurationMs;

  // 1. Prepend bumper (between-program)
  if (options.prependBumper) {
    const { path, durationMs, startOffset } = options.prependBumper;
    const bumperRemaining = durationMs - startOffset;
    const bumperSegMs = Math.min(bumperRemaining, outputRemaining);
    if (bumperSegMs > 0) {
      lines.push(`file '${path}'`);
      if (startOffset > 0) {
        lines.push(`inpoint ${startOffset / 1000}`);
      }
      lines.push(`outpoint ${(startOffset + bumperSegMs) / 1000}`);
      outputRemaining -= bumperSegMs;
    }
  }

  if (outputRemaining <= 0) {
    return lines.join('\n') + '\n';
  }

  // 2. Show content with optional within-program bumpers
  if (options.withinBumpers) {
    const withinLines = buildWithinBumperLines(
      showPath,
      programDurationMs,
      showStartMs,
      outputRemaining,
      options.withinBumpers,
      silences,
    );
    lines.push(...withinLines);
  } else {
    const showEndMs = Math.min(showStartMs + outputRemaining, programDurationMs);
    if (showEndMs > showStartMs) {
      lines.push(`file '${showPath}'`);
      if (showStartMs > 0) {
        lines.push(`inpoint ${showStartMs / 1000}`);
      }
      lines.push(`outpoint ${showEndMs / 1000}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generates the show+within-bumper ffconcat lines (without the header).
 * Interleaves show segments with bumper clips at `intervalMs` boundaries.
 */
function buildWithinBumperLines(
  showPath: string,
  programDurationMs: number,
  startOffsetMs: number,
  outputRemainingMs: number,
  bumpers: WithinBumperSegment,
  silences?: SilencePeriod[],
): string[] {
  const { intervalMs, files } = bumpers;
  const lines: string[] = [];

  const breakPointsInShowTime: number[] = [];
  for (let t = intervalMs; t < programDurationMs; t += intervalMs) {
    const absolutePosition = t;
    if (absolutePosition < MIN_LEAD_MS) continue;
    if (t > startOffsetMs) {
      const snapped = silences
        ? snapToSilence(t, silences, SILENCE_SNAP_TOLERANCE_MS)
        : t;
      breakPointsInShowTime.push(snapped);
    }
  }

  let showTime = startOffsetMs;
  let bumperIdx = Math.floor(startOffsetMs / intervalMs);
  let outputRemaining = outputRemainingMs;

  for (const breakPoint of breakPointsInShowTime) {
    if (outputRemaining <= 0) break;

    const showSegMs = Math.min(breakPoint - showTime, outputRemaining);
    if (showSegMs > 0) {
      lines.push(`file '${showPath}'`);
      lines.push(`inpoint ${showTime / 1000}`);
      lines.push(`outpoint ${(showTime + showSegMs) / 1000}`);
      outputRemaining -= showSegMs;
      showTime += showSegMs;
    }

    if (outputRemaining <= 0) break;

    const bumper = files[bumperIdx % files.length]!;
    const bumperMs = Math.min(bumper.durationMs, outputRemaining);
    if (bumperMs > 0) {
      lines.push(`file '${bumper.path}'`);
      if (bumperMs < bumper.durationMs) {
        lines.push(`outpoint ${bumperMs / 1000}`);
      }
      outputRemaining -= bumperMs;
    }
    bumperIdx++;
  }

  if (outputRemaining > 0 && showTime < programDurationMs) {
    const finalMs = Math.min(programDurationMs - showTime, outputRemaining);
    if (finalMs > 0) {
      lines.push(`file '${showPath}'`);
      lines.push(`inpoint ${showTime / 1000}`);
      lines.push(`outpoint ${(showTime + finalMs) / 1000}`);
    }
  }

  return lines;
}

function snapToSilence(
  targetMs: number,
  silences: SilencePeriod[],
  toleranceMs: number,
): number {
  let best = targetMs;
  let bestDist = toleranceMs + 1;

  for (const silence of silences) {
    const candidateMs = silence.start * 1000;
    const dist = Math.abs(candidateMs - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidateMs;
    }
  }

  return best;
}
