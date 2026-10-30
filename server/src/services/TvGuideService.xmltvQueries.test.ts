import dayjsBase from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import { v4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import type { Lineup } from '../db/derived_types/Lineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { ProgramWithRelationsOrm } from '../db/schema/derivedTypes.ts';
import dayjs from '../util/dayjs.ts';
import type { MaterializedChannelPrograms } from './XmlTvWriter.ts';

dayjsBase.extend(relativeTime);

// Break the OnDemandChannelService -> Scheduler -> container circular chain
vi.mock('./Scheduler.ts', () => ({ GlobalScheduler: {} }));

import { TVGuideService } from './TvGuideService.ts';

type Deps = ConstructorParameters<typeof TVGuideService>;
function fake<T>(impl: object): T {
  return impl as unknown as T;
}

const SHOW_MS = 10 * 60 * 1000;

function makeChannel(number: number): ChannelOrm {
  return {
    uuid: v4(),
    number,
    name: `Channel ${number}`,
    duration: SHOW_MS * 2,
    startTime: dayjs().subtract(1, 'second').valueOf(),
    createdAt: null,
    updatedAt: null,
    disableFillerOverlay: false,
    fillerRepeatCooldown: null,
    groupTitle: null,
    guideFlexTitle: null,
    guideMinimumDuration: 30_000,
    icon: { path: '', width: 0, duration: 0, position: 'bottom-right' },
    offline: { mode: 'pic' },
    stealth: false,
    streamMode: 'hls',
    transcoding: null,
    transcodeConfigId: v4(),
    watermark: null,
    subtitlesEnabled: false,
  };
}

function setup() {
  const titles: Record<string, string> = {};
  const lineups: Record<string, { channel: ChannelOrm; lineup: Lineup }> = {};
  for (const number of [1, 2, 3]) {
    const channel = makeChannel(number);
    const ids = [v4(), v4()];
    ids.forEach((id, i) => (titles[id] = `ch${number} show ${i}`));
    lineups[channel.uuid] = {
      channel,
      lineup: {
        version: 4,
        lastUpdated: Date.now(),
        items: ids.map((id) => ({ type: 'content', id, durationMs: SHOW_MS })),
        startTimeOffsets: [0, SHOW_MS],
      },
    };
  }

  const getProgramsByIds = vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      ids.map(
        (uuid) =>
          ({
            uuid,
            title: titles[uuid],
            type: 'movie',
          }) as Partial<ProgramWithRelationsOrm>,
      ),
    ),
  );
  const write = vi.fn().mockResolvedValue(undefined);
  const noop = vi.fn();
  const service = new TVGuideService(
    fake<Deps[0]>({
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      trace: noop,
      fatal: noop,
    }),
    fake<Deps[1]>({ write }),
    fake<Deps[2]>({ push: noop }),
    fake<Deps[3]>({
      loadAllLineups: vi.fn(() => Promise.resolve(structuredClone(lineups))),
    }),
    fake<Deps[4]>({ getProgramsByIds }),
    fake<Deps[5]>({}),
    fake<Deps[6]>({}),
    fake<Deps[7]>({}),
    fake<Deps[8]>({}),
  );
  const channelIds = Object.keys(lineups);
  return { service, write, getProgramsByIds, channelIds, titles };
}

function writtenTitles(write: ReturnType<typeof vi.fn>) {
  const channels = write.mock.lastCall?.[0] as MaterializedChannelPrograms[];
  return channels.flatMap((c) => c.programs.map((p) => p.title));
}

describe('TVGuideService XMLTV writes', () => {
  it('loads programs once per channel build, never again when writing XMLTV', async () => {
    const { service, write, getProgramsByIds, channelIds, titles } = setup();
    const hours = dayjs.duration({ hours: 1 });

    await service.buildAllChannels(hours, true);
    expect(getProgramsByIds).toHaveBeenCalledTimes(channelIds.length);
    expect(write).toHaveBeenCalledTimes(1);
    expect(new Set(writtenTitles(write))).toEqual(
      new Set(Object.values(titles)),
    );

    // Rebuilding one channel queries only that channel, though the XMLTV
    // file it writes still carries every channel's program metadata.
    getProgramsByIds.mockClear();
    await service.refreshGuide(hours, channelIds[0]!, true, true);
    expect(getProgramsByIds).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(new Set(writtenTitles(write))).toEqual(
      new Set(Object.values(titles)),
    );

    // Removing a channel rewrites XMLTV without any query and drops its programs.
    getProgramsByIds.mockClear();
    await service.removeCachedChannel(channelIds[1]!);
    expect(getProgramsByIds).not.toHaveBeenCalled();
    const after = writtenTitles(write);
    expect(after.some((t) => t?.startsWith('ch2 '))).toBe(false);
    expect(after.some((t) => t?.startsWith('ch1 '))).toBe(true);
  });
});
