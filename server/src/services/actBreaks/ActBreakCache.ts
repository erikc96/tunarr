import { globalOptions } from '@/globals.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { injectable } from 'inversify';
import type { Low } from 'lowdb';
import { JSONFilePreset } from 'lowdb/node';
import path from 'node:path';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'ActBreakCache',
});

export type ActBreakCacheEntry = {
  path: string;
  size: number;
  analyzedAt: string;
  status: 'ready' | 'failed';
  durationMs: number;
  chaptersMs: number[];
  strongMs: number[];
  weakMs: number[];
  error?: string;
};

type ActBreakCacheData = { entries: Record<string, ActBreakCacheEntry> };
const defaults: ActBreakCacheData = { entries: {} };

@injectable()
export class ActBreakCache {
  private db: Low<ActBreakCacheData> | undefined;

  private async getDb() {
    if (!this.db) {
      this.db = await JSONFilePreset<ActBreakCacheData>(
        path.join(globalOptions().databaseDirectory, 'act-break-cache.json'),
        defaults,
      );
      await this.db.read();
    }
    return this.db;
  }

  async get(programId: string) {
    return (await this.getDb()).data.entries[programId];
  }

  async set(programId: string, entry: ActBreakCacheEntry) {
    const db = await this.getDb();
    db.data.entries[programId] = entry;
    await db.write();
    logger.debug('Cached act breaks for %s', programId);
  }
}
