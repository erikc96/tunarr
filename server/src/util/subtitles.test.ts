import type { SubtitleStreamDetails } from '../stream/types.ts';
import { getSubtitleCacheFilePath } from './subtitles.ts';

const program = {
  id: 'p1',
  externalSourceType: 'plex',
  externalSourceId: 's1',
  externalKey: '10597',
} as const;

const external = (key: string, token: string) =>
  ({
    type: 'external',
    codec: 'srt',
    path: `http://plex/library/streams/${key}?X-Plex-Token=${token}`,
  }) as SubtitleStreamDetails;

describe('getSubtitleCacheFilePath', () => {
  test('external streams of one program get distinct cache files', () => {
    expect(getSubtitleCacheFilePath(program, external('1', 't'))).not.toEqual(
      getSubtitleCacheFilePath(program, external('2', 't')),
    );
  });

  test('auth token does not change the cache file', () => {
    expect(getSubtitleCacheFilePath(program, external('1', 'a'))).toEqual(
      getSubtitleCacheFilePath(program, external('1', 'b')),
    );
  });
});
