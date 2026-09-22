import { describe, expect, test } from 'vitest';

describe('liveChannelUrl', () => {
  test('maps channel numbers from TUNARR_LIVE_CHANNELS', async () => {
    process.env['TUNARR_LIVE_CHANNELS'] =
      '{"14":"http://127.0.0.1:8210/lofi"}';
    const { liveChannelUrl } = await import('./FfmpegStreamFactory.ts');
    expect(liveChannelUrl(14)).toBe('http://127.0.0.1:8210/lofi');
    expect(liveChannelUrl(1)).toBeUndefined();
  });
});
