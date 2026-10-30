import { faker } from '@faker-js/faker';
import { tag } from '@tunarr/types';
import dayjs from 'dayjs';
import { now, sum, sumBy } from 'lodash-es';
import { DeepPartial } from 'ts-essentials';
import { instance, mock, verify, when } from 'ts-mockito';
import { test as baseTest } from 'vitest';
import {
  Lineup,
  LineupItem,
  LineupSchema,
} from '../db/derived_types/Lineup.ts';
import { StreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import { IChannelDB } from '../db/interfaces/IChannelDB.ts';
import { IFillerListDB } from '../db/interfaces/IFillerListDB.ts';
import { IProgramDB } from '../db/interfaces/IProgramDB.ts';
import { calculateStartTimeOffsets } from '../db/lineupUtil.ts';
import { MediaSourceId } from '../db/schema/base.ts';
import { IStreamLineupCache } from '../interfaces/IStreamLineupCache.ts';
import { IFillerPicker } from '../services/interfaces/IFillerPicker.ts';
import {
  createChannelOrm,
  createFakeProgram,
} from '../testing/fakes/entityCreators.ts';
import { LoggerFactory } from '../util/logging/LoggerFactory.ts';
import {
  calculateStreamDuration,
  StreamProgramCalculator,
} from './StreamProgramCalculator.ts';

describe('StreamProgramCalculator', () => {
  baseTest('getCurrentLineupItem simple', async () => {
    const fillerDB = mock<IFillerListDB>();
    const channelDB = mock<IChannelDB>();
    const programDB = mock<IProgramDB>();
    const fillerPicker = mock<IFillerPicker>();
    const channelCache = mock<IStreamLineupCache>();

    const startTime = dayjs(new Date(2025, 8, 17, 8));
    const channelId = faker.string.uuid();
    const programId1 = faker.string.uuid();
    const programId2 = faker.string.uuid();

    const lineup: LineupItem[] = [
      {
        type: 'content',
        durationMs: +dayjs.duration({ minutes: 22 }),
        id: programId1,
      },
      {
        type: 'content',
        durationMs: +dayjs.duration({ minutes: 22 }),
        id: programId2,
      },
    ];

    when(programDB.getProgramForStream(programId1)).thenReturn(
      Promise.resolve(
        createFakeProgram({
          uuid: programId1,
          duration: lineup[0].durationMs,
          mediaSourceId: tag<MediaSourceId>('mediasource-123'),
        }),
      ),
    );

    when(programDB.getProgramForStream(programId2)).thenReturn(
      Promise.resolve(
        createFakeProgram({
          uuid: programId2,
          duration: lineup[1].durationMs,
          mediaSourceId: tag<MediaSourceId>('mediasource-123'),
        }),
      ),
    );

    const channel = createChannelOrm({
      uuid: channelId,
      number: 1,
      startTime: +startTime.subtract(1, 'hour'),
      duration: sumBy(lineup, ({ durationMs }) => durationMs),
    });

    when(channelDB.getChannelOrm(1)).thenReturn(Promise.resolve(channel));

    when(channelDB.loadLineup(channelId)).thenReturn(
      Promise.resolve({
        version: 1,
        items: lineup,
        startTimeOffsets: calculateStartTimeOffsets(lineup),
        lastUpdated: now(),
      }),
    );

    const calc = new StreamProgramCalculator(
      LoggerFactory.root,
      instance(fillerDB),
      instance(channelDB),
      instance(channelCache),
      instance(programDB),
      instance(fillerPicker),
    );

    const out = (
      await calc.getCurrentLineupItem({
        allowSkip: false,
        channelId: 1,
        startTime: +startTime,
      })
    ).get();

    expect(out.lineupItem).toMatchObject<DeepPartial<StreamLineupItem>>({
      streamDuration: +dayjs.duration(6, 'minutes'),
      program: {
        uuid: programId1,
      },
      infiniteLoop: false,
      programBeginMs: +startTime - +dayjs.duration(16, 'minutes'),
      startOffset: +dayjs.duration(16, 'minutes'),
    });

    verify(
      channelCache.recordPlayback(channel.uuid, +startTime, out.lineupItem),
    ).once();
  });

  baseTest('getCurrentLineupItem filler lineup item', async () => {
    const fillerDB = mock<IFillerListDB>();
    const channelDB = mock<IChannelDB>();
    const programDB = mock<IProgramDB>();
    const fillerPicker = mock<IFillerPicker>();
    const channelCache = mock<IStreamLineupCache>();

    const startTime = dayjs(new Date(2025, 8, 17, 8));
    const channelId = faker.string.uuid();
    const programId1 = faker.string.uuid();
    const programId2 = faker.string.uuid();
    const fillerListId = faker.string.uuid();

    const lineup: LineupItem[] = [
      {
        type: 'content',
        durationMs: +dayjs.duration({ minutes: 22 }),
        id: programId1,
        fillerListId: fillerListId,
      },
      {
        type: 'content',
        durationMs: +dayjs.duration({ minutes: 22 }),
        id: programId2,
      },
    ];

    when(programDB.getProgramForStream(programId1)).thenReturn(
      Promise.resolve(
        createFakeProgram({
          uuid: programId1,
          duration: lineup[0].durationMs,
          mediaSourceId: tag<MediaSourceId>('mediasource-123'),
        }),
      ),
    );

    when(programDB.getProgramForStream(programId2)).thenReturn(
      Promise.resolve(
        createFakeProgram({
          uuid: programId2,
          duration: lineup[1].durationMs,
          mediaSourceId: tag<MediaSourceId>('mediasource-123'),
        }),
      ),
    );

    const channel = createChannelOrm({
      uuid: channelId,
      number: 1,
      startTime: +startTime.subtract(1, 'hour'),
      duration: sumBy(lineup, ({ durationMs }) => durationMs),
    });

    when(channelDB.getChannelOrm(1)).thenReturn(Promise.resolve(channel));

    when(channelDB.loadLineup(channelId)).thenReturn(
      Promise.resolve({
        version: 1,
        items: lineup,
        startTimeOffsets: calculateStartTimeOffsets(lineup),
        lastUpdated: now(),
      }),
    );

    const calc = new StreamProgramCalculator(
      LoggerFactory.root,
      instance(fillerDB),
      instance(channelDB),
      instance(channelCache),
      instance(programDB),
      instance(fillerPicker),
    );

    const out = (
      await calc.getCurrentLineupItem({
        allowSkip: false,
        channelId: 1,
        startTime: +startTime,
      })
    ).get();

    expect(out.lineupItem).toMatchObject<DeepPartial<StreamLineupItem>>({
      streamDuration: +dayjs.duration(6, 'minutes'),
      program: {
        uuid: programId1,
      },
      infiniteLoop: false,
      programBeginMs: +startTime - +dayjs.duration(16, 'minutes'),
      startOffset: +dayjs.duration(16, 'minutes'),
      fillerId: fillerListId,
      type: 'commercial',
    });

    verify(
      channelCache.recordPlayback(channel.uuid, +startTime, out.lineupItem),
    ).once();
  });

  baseTest('getCurrentLineupItem loop filler lineup item', async () => {
    const fillerDB = mock<IFillerListDB>();
    const channelDB = mock<IChannelDB>();
    const programDB = mock<IProgramDB>();
    const fillerPicker = mock<IFillerPicker>();
    const channelCache = mock<IStreamLineupCache>();

    const startTime = dayjs(new Date(2025, 8, 17, 8));
    const channelId = faker.string.uuid();
    const programId1 = faker.string.uuid();
    const programId2 = faker.string.uuid();
    const fillerListId = faker.string.uuid();

    const lineup: LineupItem[] = [
      {
        type: 'content',
        durationMs: +dayjs.duration({ minutes: 22 }),
        id: programId1,
        fillerListId: fillerListId,
      },
      {
        type: 'content',
        durationMs: +dayjs.duration({ minutes: 22 }),
        id: programId2,
      },
    ];

    when(programDB.getProgramForStream(programId1)).thenReturn(
      Promise.resolve(
        createFakeProgram({
          uuid: programId1,
          duration: +dayjs.duration({ minutes: 2 }),
          mediaSourceId: tag<MediaSourceId>('mediasource-123'),
        }),
      ),
    );

    when(programDB.getProgramForStream(programId2)).thenReturn(
      Promise.resolve(
        createFakeProgram({
          uuid: programId2,
          duration: lineup[1].durationMs,
          mediaSourceId: tag<MediaSourceId>('mediasource-123'),
        }),
      ),
    );

    const channel = createChannelOrm({
      uuid: channelId,
      number: 1,
      startTime: +startTime.subtract(1, 'hour'),
      duration: sumBy(lineup, ({ durationMs }) => durationMs),
    });

    when(channelDB.getChannelOrm(1)).thenReturn(Promise.resolve(channel));

    when(channelDB.loadLineup(channelId)).thenReturn(
      Promise.resolve({
        version: 1,
        items: lineup,
        startTimeOffsets: calculateStartTimeOffsets(lineup),
        lastUpdated: now(),
      }),
    );

    const calc = new StreamProgramCalculator(
      LoggerFactory.root,
      instance(fillerDB),
      instance(channelDB),
      instance(channelCache),
      instance(programDB),
      instance(fillerPicker),
    );

    const out = (
      await calc.getCurrentLineupItem({
        allowSkip: false,
        channelId: 1,
        startTime: +startTime,
      })
    ).get();

    expect(out.lineupItem).toMatchObject<DeepPartial<StreamLineupItem>>({
      streamDuration: +dayjs.duration(6, 'minutes'),
      program: { uuid: programId1 },
      infiniteLoop: true,
      programBeginMs: +startTime - +dayjs.duration(16, 'minutes'),
      startOffset: +dayjs.duration(16, 'minutes'),
      fillerId: fillerListId,
      type: 'commercial',
      duration: +dayjs.duration(22, 'minutes'),
    });

    verify(
      channelCache.recordPlayback(channel.uuid, +startTime, out.lineupItem),
    ).once();
  });

  describe('calculateStreamDuration', () => {
    test('first channel cycle', () => {
      const lineupItems: LineupItem[] = [
        { type: 'content', id: '1', durationMs: 2000 },
        { type: 'content', id: '2', durationMs: 3000 },
        { type: 'content', id: '3', durationMs: 4000 },
      ];
      const offsets = calculateStartTimeOffsets(lineupItems);
      const lineup: Lineup = {
        version: 1,
        items: lineupItems,
        startTimeOffsets: offsets,
        lastUpdated: now(),
      };
      const duration = sum(lineupItems.map((i) => i.durationMs));
      // we are one "tick" into the 2nd show. there are 2 ticks
      // remaining
      // |--|---|----|
      //     ^
      const { streamDuration } = calculateStreamDuration(
        3000,
        0,
        duration,
        lineup,
        0,
      );
      expect(streamDuration).toEqual(2000);
    });

    test('next channel cycle', () => {
      const lineupItems: LineupItem[] = [
        { type: 'content', id: '1', durationMs: 2000 },
        { type: 'content', id: '2', durationMs: 3000 },
        { type: 'content', id: '3', durationMs: 4000 },
      ];
      const offsets = calculateStartTimeOffsets(lineupItems);
      const lineup: Lineup = {
        version: 1,
        items: lineupItems,
        startTimeOffsets: offsets,
        lastUpdated: now(),
      };
      const duration = sum(lineupItems.map((i) => i.durationMs));
      // we are one "tick" into the 2nd show. there are 2 ticks
      // remaining. the channel has cycled once
      // |--|---|----|
      //     ^
      const { streamDuration } = calculateStreamDuration(
        duration + 3000,
        0,
        duration,
        lineup,
        0,
      );
      expect(streamDuration).toEqual(2000);
    });

    test('loop appropriately on last item', () => {
      const lineupItems: LineupItem[] = [
        { type: 'content', id: '1', durationMs: 2000 },
        { type: 'content', id: '2', durationMs: 3000 },
        { type: 'content', id: '3', durationMs: 4000 },
      ];
      const offsets = calculateStartTimeOffsets(lineupItems);
      const lineup: Lineup = {
        version: 1,
        items: lineupItems,
        startTimeOffsets: offsets,
        lastUpdated: now(),
      };
      const duration = sum(lineupItems.map((i) => i.durationMs));
      // we are one "tick" into the 3rd show. there are 3 ticks
      // remaining in the current program.
      // |--|---|----|
      //         ^
      // The next program (after current finishes) is the first program in the channel
      const { streamDuration } = calculateStreamDuration(
        6_000,
        0,
        duration,
        lineup,
        0,
      );
      expect(streamDuration).toEqual(3000);
    });
  });
});

describe('StreamProgramCalculator lineup segments', () => {
  baseTest('a segment item seeks to its offset plus time elapsed', async () => {
    const fillerDB = mock<IFillerListDB>();
    const channelDB = mock<IChannelDB>();
    const programDB = mock<IProgramDB>();
    const fillerPicker = mock<IFillerPicker>();
    const channelCache = mock<IStreamLineupCache>();

    const startTime = dayjs(new Date(2025, 8, 17, 8));
    const channelId = faker.string.uuid();
    const episodeId = faker.string.uuid();
    const spotId = faker.string.uuid();

    // Episode split at 10:00 with a 1-min spot between the two parts.
    const lineup: LineupItem[] = [
      { type: 'content', durationMs: 600_000, id: episodeId },
      { type: 'content', durationMs: 60_000, id: spotId },
      {
        type: 'content',
        durationMs: 300_000,
        id: episodeId,
        startOffsetMs: 600_000,
      },
      { type: 'content', durationMs: 60_000, id: spotId },
    ];

    for (const [id, duration] of [
      [episodeId, 900_000],
      [spotId, 60_000],
    ] as const) {
      when(programDB.getProgramForStream(id)).thenReturn(
        Promise.resolve(
          createFakeProgram({
            uuid: id,
            duration,
            mediaSourceId: tag<MediaSourceId>('mediasource-123'),
          }),
        ),
      );
    }

    // Tune in 100 s into the second part.
    const channel = createChannelOrm({
      uuid: channelId,
      number: 1,
      startTime: +startTime - (660_000 + 100_000),
      duration: sumBy(lineup, ({ durationMs }) => durationMs),
    });
    when(channelDB.getChannelOrm(1)).thenReturn(Promise.resolve(channel));
    when(channelDB.loadLineup(channelId)).thenReturn(
      Promise.resolve({
        version: 1,
        items: lineup,
        startTimeOffsets: calculateStartTimeOffsets(lineup),
        lastUpdated: now(),
      }),
    );

    const calc = new StreamProgramCalculator(
      LoggerFactory.root,
      instance(fillerDB),
      instance(channelDB),
      instance(channelCache),
      instance(programDB),
      instance(fillerPicker),
    );

    const segment = (
      await calc.getCurrentLineupItem({
        allowSkip: false,
        channelId: 1,
        startTime: +startTime,
      })
    ).get();
    expect(segment.lineupItem).toMatchObject<DeepPartial<StreamLineupItem>>({
      type: 'program',
      program: { uuid: episodeId },
      startOffset: 700_000,
      streamDuration: 200_000,
      duration: 900_000,
      programBeginMs: +startTime - 100_000,
    });

    // The first part is not a segment: it starts at the file's beginning.
    const first = (
      await calc.getCurrentLineupItem({
        allowSkip: false,
        channelId: 1,
        startTime: +startTime - 660_000,
      })
    ).get();
    expect(first.lineupItem).toMatchObject<DeepPartial<StreamLineupItem>>({
      program: { uuid: episodeId },
      startOffset: 100_000,
      streamDuration: 500_000,
      duration: 600_000,
    });
  });

  baseTest('a saved lineup keeps segment offsets', () => {
    const parsed = LineupSchema.parse({
      version: 1,
      items: [
        {
          type: 'content',
          id: 'p',
          durationMs: 300_000,
          startOffsetMs: 600_000,
        },
      ],
      startTimeOffsets: [0],
      lastUpdated: 0,
    });
    expect(parsed.items[0]).toMatchObject({ startOffsetMs: 600_000 });
  });
});
