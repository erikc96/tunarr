import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { QualityProfileNames } from '../../stream/qualityProfiles.ts';

// A viewing device (a Roku on a CRT, the Fire stick, ...) identified by its
// own app password. The slug is the Basic-auth username; only a hash of the
// password is kept.
export const ClientDevice = sqliteTable(
  'client_device',
  {
    uuid: text().primaryKey(),
    slug: text().notNull(),
    name: text().notNull(),
    profile: text({ enum: QualityProfileNames }).notNull(),
    secretHash: text().notNull(),
    createdAt: integer().notNull(),
    lastSeenAt: integer(),
    lastIp: text(),
    revokedAt: integer(),
  },
  (table) => [unique('client_device_slug_unique').on(table.slug)],
);

export type ClientDevice = InferSelectModel<typeof ClientDevice>;
export type NewClientDevice = InferInsertModel<typeof ClientDevice>;
