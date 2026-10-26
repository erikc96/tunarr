import {
  applyProfile,
  profileWeight,
  resolveProfile,
} from './qualityProfiles.ts';

describe('resolveProfile', () => {
  test('a device beats size', () => {
    expect(resolveProfile({ device: { profile: '480p' }, size: 'full' })).toBe(
      '480p',
    );
  });
  test('size maps pip to 720p and full to 1080p', () => {
    expect(resolveProfile({ size: 'pip' })).toBe('720p');
    expect(resolveProfile({ size: 'full' })).toBe('1080p');
  });
  test('nothing selects the channel default', () => {
    expect(resolveProfile({})).toBeUndefined();
  });
});

describe('applyProfile', () => {
  const cfg = {
    resolution: { widthPx: 1920, heightPx: 1080 },
    videoBitRate: 10000,
    videoBufferSize: 20000,
    audioBitRate: 192,
    name: 'x',
  };
  test('480p overrides size and bitrates, keeps other fields', () => {
    const out = applyProfile(cfg, '480p');
    expect(out.resolution).toEqual({ widthPx: 854, heightPx: 480 });
    expect(out.videoBitRate).toBe(1200);
    expect(out.name).toBe('x');
    expect(cfg.videoBitRate).toBe(10000);
  });
  test('1080p and undefined leave the config alone', () => {
    expect(applyProfile(cfg, '1080p')).toBe(cfg);
    expect(applyProfile(cfg, undefined)).toBe(cfg);
  });
  test('weights', () => {
    expect(
      [undefined, '1080p', '720p', '480p'].map((p) =>
        profileWeight(p as never),
      ),
    ).toEqual([1, 1, 0.5, 0.25]);
  });
});
