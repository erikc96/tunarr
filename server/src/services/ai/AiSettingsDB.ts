import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import type { AiSettings, AiSettingsPublic } from '@tunarr/types/schemas';
import { AiSettingsSchema } from '@tunarr/types/schemas';
import { injectable } from 'inversify';
import { Low } from 'lowdb';
import { JSONFilePreset } from 'lowdb/node';
import path from 'node:path';
import { globalOptions } from '@/globals.js';

const logger = LoggerFactory.child({
  caller: import.meta,
  className: 'AiSettingsDB',
});

const DEFAULTS: AiSettings = AiSettingsSchema.parse({});

@injectable()
export class AiSettingsDB {
  private db: Low<AiSettings> | null = null;

  private async getDb(): Promise<Low<AiSettings>> {
    if (!this.db) {
      const dbPath = path.join(
        globalOptions().databaseDirectory,
        'ai-settings.json',
      );
      this.db = await JSONFilePreset<AiSettings>(dbPath, DEFAULTS);
      await this.db.read();
      logger.debug('AI settings loaded from %s', dbPath);
    }
    return this.db;
  }

  async get(): Promise<AiSettings> {
    const db = await this.getDb();
    return db.data;
  }

  async getPublic(): Promise<AiSettingsPublic> {
    const settings = await this.get();
    return {
      model: settings.model,
      enabled: settings.enabled,
      hasApiKey: !!settings.apiKey,
      autoScanEnabled: settings.autoScanEnabled,
      autoScanIntervalMinutes: settings.autoScanIntervalMinutes,
    };
  }

  // Epoch ms until which the AI scheduler skips its run after a billing
  // error. Kept in the settings file so a Tunarr restart doesn't reset it.
  async getBillingBackoffUntil(): Promise<number> {
    const db = await this.getDb();
    const v = (db.data as { billingBackoffUntil?: unknown }).billingBackoffUntil;
    return typeof v === 'number' ? v : 0;
  }

  async setBillingBackoffUntil(until: number): Promise<void> {
    const db = await this.getDb();
    (db.data as { billingBackoffUntil?: number }).billingBackoffUntil = until;
    await db.write();
  }

  async update(data: Partial<AiSettings>): Promise<AiSettingsPublic> {
    const db = await this.getDb();
    if (typeof data.apiKey === 'string') db.data.apiKey = data.apiKey;
    if (typeof data.model === 'string') db.data.model = data.model;
    if (typeof data.enabled === 'boolean') db.data.enabled = data.enabled;
    if (typeof data.autoScanEnabled === 'boolean')
      db.data.autoScanEnabled = data.autoScanEnabled;
    if (typeof data.autoScanIntervalMinutes === 'number')
      db.data.autoScanIntervalMinutes = data.autoScanIntervalMinutes;
    await db.write();
    return this.getPublic();
  }
}
