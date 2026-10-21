import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FFmpegFactory } from '@/ffmpeg/FFmpegModule.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { MpegTsOutputFormat } from '@/ffmpeg/builder/constants.js';
import { ConcatStreamModeToChildMode } from '@/ffmpeg/ffmpegBase.js';
import { makeFfmpegPlaylistUrl, makeLocalUrl } from '@/util/serverUtil.js';
import type { ChannelConcatStreamMode } from '@tunarr/types/schemas';
import type { LowQualityConcatSessionType } from './Session.js';

type ConcatStreamMode = ChannelConcatStreamMode | LowQualityConcatSessionType;

export type ConcatStreamFactory = (
  channel: ChannelOrmWithTranscodeConfig,
  streamMode: ConcatStreamMode,
) => ConcatStream;
export class ConcatStream {
  constructor(
    private channel: ChannelOrmWithTranscodeConfig,
    private streamMode: ConcatStreamMode,
    private ffmpegFactory: FFmpegFactory,
  ) {}

  async createSession(): Promise<FfmpegTranscodeSession> {
    const quality = this.streamMode.endsWith('_low')
      ? 'low'
      : this.streamMode.endsWith('_fire')
        ? 'fire'
        : undefined;
    const streamMode = this.streamMode.replace(
      /_(low|fire)$/,
      '',
    ) as ChannelConcatStreamMode;
    const ffmpeg = this.ffmpegFactory(
      this.channel.transcodeConfig,
      this.channel,
      ConcatStreamModeToChildMode[streamMode],
    );

    switch (streamMode) {
      // If we're wrapping an HLS stream, direct the concat process to
      // the m3u8 URL
      case 'hls_concat':
      case 'hls_slower_concat':
      case 'hls_direct_concat': {
        const childStreamMode = ConcatStreamModeToChildMode[streamMode];
        return ffmpeg.createHlsWrapperSession(
          makeLocalUrl(`/stream/channels/${this.channel.uuid}.m3u8`, {
            mode: childStreamMode,
          }),
          {
            outputFormat: MpegTsOutputFormat,
            mode: streamMode,
            quality,
          },
        );
      }
      case 'mpegts_concat':
        // MPEG-TS concat has no HLS child stream to wrap, so low quality
        // deliberately falls back to the existing stream-copy output.
        return ffmpeg.createConcatSession(
          makeFfmpegPlaylistUrl({
            channel: this.channel.uuid,
            audioOnly: false, // TODO
            mode: 'mpegts',
          }),
          {
            outputFormat: MpegTsOutputFormat,
            mode: streamMode,
          },
        );
    }
  }
}
