import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import type { BumperPack } from '@tunarr/types/schemas';
import { injectable } from 'inversify';
import { Low } from 'lowdb';
import { JSONFilePreset } from 'lowdb/node';
import path from 'node:path';
import { globalOptions } from '@/globals.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'BumperDB',
});

interface BumperData {
  packs: BumperPack[];
}

const DEFAULTS: BumperData = { packs: [] };

@injectable()
export class BumperDB {
  private db: Low<BumperData> | null = null;

  private async getDb(): Promise<Low<BumperData>> {
    if (!this.db) {
      const dbPath = path.join(
        globalOptions().databaseDirectory,
        'bumpers.json',
      );
      this.db = await JSONFilePreset<BumperData>(dbPath, DEFAULTS);
      await this.db.read();
      logger.debug('Bumper packs loaded from %s', dbPath);
    }
    return this.db;
  }

  async getPacks(): Promise<BumperPack[]> {
    const db = await this.getDb();
    return db.data.packs;
  }

  async getPackById(id: string): Promise<BumperPack | undefined> {
    const db = await this.getDb();
    return db.data.packs.find((p) => p.id === id);
  }

  async savePack(pack: BumperPack): Promise<void> {
    const db = await this.getDb();
    const idx = db.data.packs.findIndex((p) => p.id === pack.id);
    if (idx >= 0) {
      db.data.packs[idx] = pack;
    } else {
      db.data.packs.push(pack);
    }
    await db.write();
    logger.debug('Saved bumper pack %s (%s)', pack.name, pack.id);
  }

  async deletePack(id: string): Promise<boolean> {
    const db = await this.getDb();
    const before = db.data.packs.length;
    db.data.packs = db.data.packs.filter((p) => p.id !== id);
    if (db.data.packs.length < before) {
      await db.write();
      return true;
    }
    return false;
  }
}
