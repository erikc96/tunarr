import type { ContentItem, LineupItem } from '@/db/derived_types/Lineup.js';
import { BumperDB } from '@/services/bumpers/BumperDB.js';
import type { InsertBumpersOperation } from '@tunarr/types/api';
import type { LegacyChannelAndLineup } from '../../db/interfaces/IChannelDB.ts';
import { SchedulingOperator } from './SchedulingOperator.ts';

/**
 * Inserts bumper ContentLineupItems between (and optionally at the start of)
 * the channel's content items. Bumpers are drawn from the configured pack
 * and inserted in round-robin order.
 */
export class InsertBumpersOperator extends SchedulingOperator<InsertBumpersOperation> {
  constructor(
    config: InsertBumpersOperation,
    private bumperDB: BumperDB,
  ) {
    super(config);
  }

  public async apply({
    channel,
    lineup,
  }: LegacyChannelAndLineup): Promise<LegacyChannelAndLineup> {
    const pack = await this.bumperDB.getPackById(this.config.packId);
    if (!pack || pack.files.length === 0) {
      return { channel, lineup };
    }

    const files = pack.files;
    let bumperIndex = 0;
    const nextBumper = (): ContentItem => {
      const file = files[bumperIndex % files.length]!;
      bumperIndex++;
      return {
        type: 'content',
        id: file.programUuid,
        durationMs: file.durationMs,
        isBumper: true,
      };
    };

    const items = [...lineup.items];
    const result: LineupItem[] = [];

    // Optionally insert a bumper at the channel start
    if (this.config.placement === 'within') {
      result.push(nextBumper());
    }

    let episodeCount = 0;
    for (const item of items) {
      // Skip already-inserted bumpers to avoid cascading on re-apply
      if (item.type === 'content' && item.isBumper) {
        continue;
      }

      result.push(item);

      // Only insert between content items (not after offline/redirect)
      if (item.type === 'content') {
        episodeCount++;
        if (episodeCount % this.config.count === 0) {
          result.push(nextBumper());
        }
      }
    }

    return {
      channel,
      lineup: {
        ...lineup,
        items: result,
      },
    };
  }
}
