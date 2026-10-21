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
    expect(concatSessionTypeForQuality('hls', 'fire')).toBe('hls_concat_fire');
  });
});
