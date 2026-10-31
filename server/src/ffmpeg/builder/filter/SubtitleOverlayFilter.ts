import type { PixelFormat } from '../format/PixelFormat.ts';
import { FilterOption } from './FilterOption.ts';

export class SubtitleOverlayFilter extends FilterOption {
  constructor(private desiredPixelFormat: PixelFormat) {
    super();
  }

  get filter() {
    // The crop keeps libx264 happy: overlaying a PGS stream on some sources
    // (a 642x480 anamorphic Cheers episode) yields 1920x1081, and the encoder
    // rejects odd heights, so the channel only ever showed the error screen.
    return `overlay=x=(W-w)/2:y=(H-h)/2:format=${this.desiredPixelFormat.bitDepth === 10 ? 1 : 0},crop=trunc(iw/2)*2:trunc(ih/2)*2`;
  }
}
