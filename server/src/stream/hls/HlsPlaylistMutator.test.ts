import dayjs from 'dayjs';
import { readTestFile } from '../../testing/util.ts';
import { HlsPlaylistMutator } from './HlsPlaylistMutator.ts';

test('HlsPlaylistMutator', async () => {
  const mutator = new HlsPlaylistMutator();
  const lines = (await readTestFile('test.m3u8')).toString('utf-8').split('\n');
  const start = dayjs('2024-10-18T14:01:55.164-0400');

  const newPlaylist = mutator.trimPlaylist(
    start,
    start.subtract(30, 'seconds'),
    lines,
    10,
    true,
  );

  console.log(
    mutator.parsePlaylist(start, newPlaylist.playlist.split('\n'), true),
  );
});

describe('live edge', () => {
  const seg = (n: number) =>
    `#EXTINF:4.000000,\n#EXT-X-PROGRAM-DATE-TIME:x\ndata${String(n).padStart(6, '0')}.ts`;
  const lines = ['#EXTM3U', ...Array.from({ length: 30 }, (_, i) => seg(i))]
    .join('\n')
    .split('\n');

  test('without a live edge a young session serves the first 10 segments', () => {
    const start = dayjs();
    const out = new HlsPlaylistMutator().trimPlaylist(
      start,
      start.subtract(30, 'seconds'),
      lines,
    );
    expect(out.sequence).toBe(0);
    expect(out.segmentCount).toBe(10);
  });

  test('the window slides with the clock when a live edge is given', () => {
    const start = dayjs().subtract(40, 'seconds');
    const m = new HlsPlaylistMutator();
    const out = m.trimPlaylist(
      start,
      start.subtract(30, 'seconds'),
      lines,
      10,
      false,
      dayjs().add(4, 'seconds'),
    );
    // 44 s elapsed incl. lead => segments 0..11 have started; newest 10 served.
    expect(out.segmentCount).toBe(10);
    expect(out.sequence).toBeGreaterThanOrEqual(2);
    expect(out.playlist).not.toContain('data000029.ts');
  });

  test('never serves an empty playlist', () => {
    const start = dayjs().add(60, 'seconds');
    const out = new HlsPlaylistMutator().trimPlaylist(
      start,
      start,
      lines,
      10,
      false,
      dayjs(),
    );
    expect(out.segmentCount).toBe(1);
  });
});
