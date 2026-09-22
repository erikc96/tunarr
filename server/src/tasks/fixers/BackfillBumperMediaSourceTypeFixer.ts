import type { DrizzleDBAccess } from '@/db/schema/index.js';
import { MediaSource } from '@/db/schema/MediaSource.js';
import {
  BUMPER_SOURCE_MEDIA_TYPE,
  BUMPER_SOURCE_PREFIX,
} from '@/services/bumpers/BumperScanner.js';
import { KEYS } from '@/types/inject.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import { and, eq, isNull, like } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import Fixer from './fixer.ts';

/**
 * Bumper packs used to create their backing local media source without a
 * mediaType, which convertToApiMediaSource rejects. Backfill it so those
 * sources serialize again.
 */
@injectable()
export class BackfillBumperMediaSourceTypeFixer extends Fixer {
  constructor(
    @inject(KEYS.Logger) protected logger: Logger,
    @inject(KEYS.DrizzleDB) private drizzle: DrizzleDBAccess,
  ) {
    super();
  }

  protected async runInternal(): Promise<void> {
    const updated = await this.drizzle
      .update(MediaSource)
      .set({ mediaType: BUMPER_SOURCE_MEDIA_TYPE })
      .where(
        and(
          eq(MediaSource.type, 'local'),
          isNull(MediaSource.mediaType),
          like(MediaSource.name, `${BUMPER_SOURCE_PREFIX}%`),
        ),
      )
      .returning({ uuid: MediaSource.uuid });

    if (updated.length > 0) {
      this.logger.info(
        'Backfilled mediaType on %d bumper media source(s)',
        updated.length,
      );
    }
  }
}
