import { describe, expect, it } from 'vitest';
import {
  deriveActBreakCandidates,
  parseDetectionOutput,
  parseFfprobeOutput,
} from './ActBreakAnalyzer.ts';

describe('ActBreakAnalyzer parsing', () => {
  it('parses ffprobe chapter starts and duration', () => {
    expect(
      parseFfprobeOutput(
        '{"format":{"duration":"1800.5"},"chapters":[{"start_time":"0"},{"start_time":"661.2"}]}',
      ),
    ).toEqual({ durationMs: 1_800_500, chaptersMs: [0, 661_200] });
  });

  it('parses realistic blackdetect and silencedetect output', () => {
    expect(
      parseDetectionOutput(`
[blackdetect @ 0x55] black_start:661.2 black_end:661.8 black_duration:0.6
[silencedetect @ 0x56] silence_start: 661.1
[silencedetect @ 0x56] silence_end: 662.0 | silence_duration: 0.9`),
    ).toEqual({
      blacks: [{ start: 661.2, end: 661.8 }],
      silences: [{ start: 661.1, end: 662 }],
    });
  });

  it('derives bounded, deduplicated strong and weak candidates', () => {
    expect(
      deriveActBreakCandidates(
        1_800_000,
        [0, 661_200, 1_750_000],
        [{ start: 661.2, end: 661.8 }],
        [
          { start: 661.1, end: 662 },
          { start: 900, end: 901.2 },
        ],
      ),
    ).toEqual({
      chaptersMs: [661_200],
      strongMs: [661_500],
      weakMs: [900_600],
    });
  });
});
