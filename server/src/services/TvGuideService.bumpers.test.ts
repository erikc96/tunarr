import dayjsBase from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import { v4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import type { Lineup } from '../db/derived_types/Lineup.ts';
import type { ChannelOrm } from '../db/schema/Channel.ts';
import type { MaterializedGuideItem } from '../types/guide.ts';
import dayjs from '../util/dayjs.ts';
import type { MaterializedChannelPrograms } from './XmlTvWriter.ts';

dayjsBase.extend(relativeTime);

// Break the OnDemandChannelService -> Scheduler -> container circular chain
vi.mock('./Scheduler.ts', () => ({ GlobalScheduler: {} }));

import { TVGuideService, isProgramOffline } from './TvGuideService.ts';

type Deps = ConstructorParameters<typeof TVGuideService>;
// Test doubles implement only what the guide build touches.
function fake<T>(impl: object): T {
  return impl as unknown as T;
}

const SHOW_MS = 10 * 60 * 1000;
const BUMP_MS = 15_000;

function setup(bumpInPack: boolean, splitShowA = false) {
  const showA = v4();
  const bump = v4();
  const bumperIds = bumpInPack ? [bump] : [];
  const showB = v4();
  const channel: ChannelOrm = {
    uuid: v4(),
    number: 22,
    name: 'Adult Swim',
    duration: SHOW_MS * 2 + BUMP_MS,
    // Channel started 1 s ago, so show A is playing now.
    startTime: dayjs().subtract(1, 'second').valueOf(),
    createdAt: null,
    updatedAt: null,
    disableFillerOverlay: false,
    fillerRepeatCooldown: null,
    groupTitle: null,
    guideFlexTitle: null,
    // 30 s: anything this short is "stealth" unless it is a bumper.
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
  const lineup: Lineup = {
    version: 4,
    lastUpdated: Date.now(),
    items: [
      { type: 'content', id: showA, durationMs: SHOW_MS },
      { type: 'content', id: bump, durationMs: BUMP_MS },
      splitShowA
        ? {
            type: 'content',
            id: showA,
            durationMs: SHOW_MS,
            startOffsetMs: SHOW_MS,
          }
        : { type: 'content', id: showB, durationMs: SHOW_MS },
    ],
    startTimeOffsets: [0, SHOW_MS, SHOW_MS + BUMP_MS],
  };
  const write = vi.fn().mockResolvedValue(undefined);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    setBindings: vi.fn(),
    isLevelEnabled: vi.fn().mockReturnValue(false),
  };
  const service = new TVGuideService(
    fake<Deps[0]>(logger),
    fake<Deps[1]>({ write }),
    fake<Deps[2]>({ push: vi.fn() }),
    fake<Deps[3]>({
      loadAllLineups: vi
        .fn()
        .mockResolvedValue({ [channel.uuid]: { channel, lineup } }),
    }),
    fake<Deps[4]>({ getProgramsByIds: vi.fn().mockResolvedValue([]) }),
    fake<Deps[5]>({}),
    fake<Deps[6]>({}),
    fake<Deps[7]>({}),
    fake<Deps[8]>({}),
    fake<Deps[9]>({
      getPacks: vi.fn().mockResolvedValue([
        {
          id: v4(),
          name: 'adult swim bumpers',
          files: bumperIds.map((programUuid) => ({
            filename: 'bump.mp4',
            path: '/bumpers/bump.mp4',
            durationMs: BUMP_MS,
            programUuid,
          })),
        },
      ]),
    }),
  );
  return { service, write };
}

async function guideFor(
  write: ReturnType<typeof vi.fn>,
): Promise<MaterializedGuideItem[]> {
  const written = write.mock.calls[0]?.[0] as MaterializedChannelPrograms[];
  return written[0]?.programs ?? [];
}

describe('TVGuideService bumpers', () => {
  it('lists a bumper-pack program as its own entry, not melded into the show before it', async () => {
    const { service, write } = setup(true);
    await service.buildAllChannels(dayjs.duration({ hours: 1 }), true);
    const programs = await guideFor(write);

    expect(programs.slice(0, 3).map((p) => p.durationMs)).toEqual([
      SHOW_MS,
      BUMP_MS,
      SHOW_MS,
    ]);
    expect(programs[1]?.isBumper).toBe(true);
    expect(programs[0]?.isBumper).toBeUndefined();
    expect(programs[1]?.start).toBe(programs[0]!.stop);
  });

  it('still melds a short program that is not in a bumper pack (stealth)', async () => {
    const { service, write } = setup(false);
    await service.buildAllChannels(dayjs.duration({ hours: 1 }), true);
    const programs = await guideFor(write);

    // The bump is absorbed into show A (upstream's stealth behaviour).
    expect(programs[0]?.durationMs).toBeGreaterThanOrEqual(SHOW_MS + BUMP_MS);
    expect(programs.some((p) => p.durationMs === BUMP_MS)).toBe(false);
    expect(programs.some((p) => p.isBumper)).toBe(false);
  });

  it('lists the parts of a split episode as separate entries at exact times', async () => {
    const { service, write } = setup(true, true);
    await service.buildAllChannels(dayjs.duration({ hours: 1 }), true);
    const programs = await guideFor(write);

    expect(programs.slice(0, 3).map((p) => p.durationMs)).toEqual([
      SHOW_MS,
      BUMP_MS,
      SHOW_MS,
    ]);
    expect(programs[2]?.start).toBe(programs[0]!.start + SHOW_MS + BUMP_MS);
  });

  it('isProgramOffline: a flagged bumper is never stealth', () => {
    const channel = { guideMinimumDuration: 30_000 };
    expect(
      isProgramOffline(
        { type: 'content', id: v4(), durationMs: BUMP_MS },
        channel,
      ),
    ).toBe(true);
    expect(
      isProgramOffline(
        { type: 'content', id: v4(), durationMs: BUMP_MS, isBumper: true },
        channel,
      ),
    ).toBe(false);
  });
});
