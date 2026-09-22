import { globalOptions } from '@/globals.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { injectable } from 'inversify';
import { Low } from 'lowdb';
import { JSONFilePreset } from 'lowdb/node';
import path from 'node:path';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'SilenceCache',
});

export type SilencePeriod = { start: number; end: number }; // seconds

interface SilenceCacheEntry {
  analyzedAt: string;
  silences: SilencePeriod[];
}

interface SilenceCacheData {
  entries: Record<string, SilenceCacheEntry>;
}

const DEFAULTS: SilenceCacheData = { entries: {} };

@injectable()
export class SilenceCache {
  private db: Low<SilenceCacheData> | null = null;

  private async getDb(): Promise<Low<SilenceCacheData>> {
    if (!this.db) {
      const dbPath = path.join(
        globalOptions().databaseDirectory,
        'silence-cache.json',
      );
      this.db = await JSONFilePreset<SilenceCacheData>(dbPath, DEFAULTS);
      await this.db.read();
    }
    return this.db;
  }

  async get(filePath: string): Promise<SilencePeriod[] | undefined> {
    const db = await this.getDb();
    return db.data.entries[filePath]?.silences;
  }

  async set(filePath: string, silences: SilencePeriod[]): Promise<void> {
    const db = await this.getDb();
    db.data.entries[filePath] = {
      analyzedAt: new Date().toISOString(),
      silences,
    };
    await db.write();
    logger.debug(
      'Cached %d silence periods for %s',
      silences.length,
      filePath,
    );
  }

  async has(filePath: string): Promise<boolean> {
    const db = await this.getDb();
    return filePath in db.data.entries;
  }
}
