import type { MediaStream } from '@/ffmpeg/builder/MediaStream.js';
import type { InputSource } from '@/ffmpeg/builder/input/InputSource.js';
import { LocalConcatStreamSource } from '@/stream/types.js';
import { InputOption } from './InputOption.ts';

/**
 * Adds `-f concat -safe 0` input options for local ffconcat files used when
 * inserting bumpers within a program's playback.
 */
export class LocalConcatFormatOption extends InputOption {
  appliesToInput(input: InputSource<MediaStream>): boolean {
    return input.source instanceof LocalConcatStreamSource;
  }

  options(): string[] {
    return ['-f', 'concat', '-safe', '0'];
  }
}
