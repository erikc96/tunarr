import {
  ChannelTsQuerySchema,
  concatSessionTypeForQuality,
} from './streamApi.ts';

describe('channel MPEG-TS quality query', () => {
  test('accepts low and high quality and rejects other values', () => {
    expect(ChannelTsQuerySchema.safeParse({ quality: 'low' }).success).toBe(
      true,
    );
    expect(ChannelTsQuerySchema.safeParse({ quality: 'high' }).success).toBe(
      true,
    );
    expect(ChannelTsQuerySchema.safeParse({ quality: 'medium' }).success).toBe(
      false,
    );
  });

  test('accepts fire quality', () => {
    expect(ChannelTsQuerySchema.safeParse({ quality: 'fire' }).success).toBe(
      true,
    );
  });

  test('uses a distinct session type for low quality', () => {
    expect(concatSessionTypeForQuality('hls', 'high')).toBe('hls_concat');
    expect(concatSessionTypeForQuality('hls', 'low')).toBe('hls_concat_low');
    expect(concatSessionTypeForQuality('hls', 'fire')).toBe(
      'hls~480p_concat_fire',
    );
    expect(concatSessionTypeForQuality('mpegts', 'fire')).toBe(
      'mpegts_concat_fire',
    );
  });

  test('reduced profiles get their own wrapper; fire and 1080p do not', () => {
    expect(concatSessionTypeForQuality('hls', undefined, '480p')).toBe(
      'hls~480p_concat',
    );
    expect(concatSessionTypeForQuality('hls', 'low', '720p')).toBe(
      'hls~720p_concat',
    );
    expect(concatSessionTypeForQuality('hls', 'fire', '720p')).toBe(
      'hls~480p_concat_fire',
    );
    expect(concatSessionTypeForQuality('hls', undefined, '1080p')).toBe(
      'hls_concat',
    );
    expect(concatSessionTypeForQuality('mpegts', undefined, '480p')).toBe(
      'mpegts_concat',
    );
  });
});
