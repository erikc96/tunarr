import type { MediaStream } from '@/ffmpeg/builder/MediaStream.js';
import type { InputSource } from '@/ffmpeg/builder/input/InputSource.js';
import { InputOption } from '@/ffmpeg/builder/options/input/InputOption.js';

// Starts reading a live HLS playlist this many segments behind the live edge.
// With a matching -readrate_initial_burst the wrapper hands a new viewer that much
// media at once, so a player on a weak link (Fire TV) has a cushion to ride out lumpy delivery.
export class HlsLiveStartIndexOption extends InputOption {
  constructor(private segmentsBehind: number) {
    super();
  }

  appliesToInput(input: InputSource<MediaStream>): boolean {
    return input.protocol === 'http' && input.continuity === 'infinite';
  }

  options(): string[] {
    return ['-live_start_index', `-${this.segmentsBehind}`];
  }

  affectsFrameState: boolean = false;
}
