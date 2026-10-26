import { eq, isNull } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { v4 } from 'uuid';
import {
  isQualityProfileName,
  type QualityProfileName,
} from '../stream/qualityProfiles.ts';
import { KEYS } from '../types/inject.ts';
import { ClientDevice } from './schema/ClientDevice.ts';
import { DrizzleDBAccess } from './schema/index.ts';

export const DeviceSlugRegex = /^[a-z][a-z0-9_-]{1,31}$/;

export const hashAppPassword = (password: string) =>
  createHash('sha256').update(password).digest('hex');

export function verifyAppPassword(password: string, secretHash: string) {
  const a = Buffer.from(hashAppPassword(password), 'hex');
  const b = Buffer.from(secretHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// nginx accepts {SHA} (base64 sha1) lines in an htpasswd file.
export const htpasswdLine = (slug: string, password: string) =>
  `${slug}:{SHA}${createHash('sha1').update(password).digest('base64')}`;

export type PublicDevice = Omit<ClientDevice, 'secretHash'>;

const toPublic = ({ secretHash: _, ...rest }: ClientDevice): PublicDevice =>
  rest;

/**
 * Devices and their app passwords. When TUNARR_HTPASSWD_FILE is set (the
 * box's nginx basic-auth file) creating a device also adds its login there
 * and revoking removes it, so nginx lets the device in.
 */
@injectable()
export class ClientDeviceDB {
  #lastSeenWritten = new Map<string, number>();

  constructor(@inject(KEYS.DrizzleDB) private drizzle: DrizzleDBAccess) {}

  async list(): Promise<PublicDevice[]> {
    const rows = await this.drizzle.select().from(ClientDevice);
    return rows.map(toPublic);
  }

  /** Returns the device and its password; the password is never kept. */
  async create(
    name: string,
    slug: string,
    profile: QualityProfileName,
  ): Promise<{ device: PublicDevice; password: string }> {
    if (!DeviceSlugRegex.test(slug) || !isQualityProfileName(profile)) {
      throw new Error('Invalid device slug or profile');
    }
    const password = randomBytes(18).toString('base64url').slice(0, 24);
    const row = {
      uuid: v4(),
      slug,
      name,
      profile,
      secretHash: hashAppPassword(password),
      createdAt: Date.now(),
    };
    await this.drizzle.insert(ClientDevice).values(row);
    await this.#htpasswd((file) =>
      appendFile(file, htpasswdLine(slug, password) + '\n'),
    );
    return {
      device: toPublic({
        ...row,
        lastSeenAt: null,
        lastIp: null,
        revokedAt: null,
      }),
      password,
    };
  }

  async update(
    uuid: string,
    patch: { name?: string; profile?: QualityProfileName },
  ) {
    if (patch.profile !== undefined && !isQualityProfileName(patch.profile)) {
      throw new Error('Invalid profile');
    }
    await this.drizzle
      .update(ClientDevice)
      .set(patch)
      .where(eq(ClientDevice.uuid, uuid));
  }

  async revoke(uuid: string) {
    const row = await this.drizzle.query.clientDevices.findFirst({
      where: (f, { eq }) => eq(f.uuid, uuid),
    });
    if (!row) {
      return;
    }
    await this.drizzle
      .update(ClientDevice)
      .set({ revokedAt: Date.now() })
      .where(eq(ClientDevice.uuid, uuid));
    await this.#htpasswd(async (file) => {
      const lines = (await readFile(file, 'utf8')).split('\n');
      await writeFile(
        file,
        lines.filter((l) => !l.startsWith(`${row.slug}:`)).join('\n'),
      );
    });
  }

  /** The active device this login belongs to, if the password is right. */
  async verify(slug: string, password: string, ip?: string) {
    const row = await this.drizzle.query.clientDevices.findFirst({
      where: (f, { and, eq }) => and(eq(f.slug, slug), isNull(f.revokedAt)),
    });
    if (!row || !verifyAppPassword(password, row.secretHash)) {
      return undefined;
    }
    const now = Date.now();
    if (now - (this.#lastSeenWritten.get(row.uuid) ?? 0) > 60_000) {
      this.#lastSeenWritten.set(row.uuid, now);
      await this.drizzle
        .update(ClientDevice)
        .set({ lastSeenAt: now, lastIp: ip ?? null })
        .where(eq(ClientDevice.uuid, row.uuid));
    }
    return toPublic(row);
  }

  async #htpasswd(fn: (file: string) => Promise<unknown>) {
    const file = process.env['TUNARR_HTPASSWD_FILE'];
    if (file) {
      await fn(file);
    }
  }
}
