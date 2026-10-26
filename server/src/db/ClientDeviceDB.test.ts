import tmp from 'tmp-promise';
import { test as baseTest } from 'vitest';
import { bootstrapTunarr } from '../bootstrap.ts';
import { globalOptions, setGlobalOptions } from '../globals.ts';
import {
  ClientDeviceDB,
  hashAppPassword,
  htpasswdLine,
  verifyAppPassword,
} from './ClientDeviceDB.ts';
import { DBAccess } from './DBAccess.ts';

const test = baseTest.extend<{ devices: ClientDeviceDB }>({
  devices: async ({}, use) => {
    const dir = await tmp.dir({ unsafeCleanup: true });
    setGlobalOptions({ database: dir.path, log_level: 'info', verbose: 0 });
    await bootstrapTunarr(globalOptions(), ':memory:');
    const conn = DBAccess.instance.getConnection(':memory:');
    await use(new ClientDeviceDB(conn!.drizzle));
    await dir.cleanup();
  },
});

describe('app password helpers', () => {
  test('hash verifies only the right password', () => {
    const h = hashAppPassword('s3cret');
    expect(verifyAppPassword('s3cret', h)).toBe(true);
    expect(verifyAppPassword('nope', h)).toBe(false);
  });
  test('htpasswd line uses {SHA}', () => {
    expect(htpasswdLine('a', 'password')).toBe(
      'a:{SHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=',
    );
  });
});

describe('ClientDeviceDB', () => {
  test('create stores only a hash; verify, wrong password, revoke', async ({
    devices,
  }) => {
    const { device, password } = await devices.create(
      'Den Roku',
      'roku-den',
      '480p',
    );
    expect(password).toHaveLength(24);
    expect(JSON.stringify(await devices.list())).not.toContain(password);
    expect((await devices.verify('roku-den', password))?.profile).toBe('480p');
    expect(await devices.verify('roku-den', 'wrong')).toBeUndefined();
    expect(await devices.verify('other', password)).toBeUndefined();
    await devices.revoke(device.uuid);
    expect(await devices.verify('roku-den', password)).toBeUndefined();
  });

  test('rejects a bad slug and duplicate slug', async ({ devices }) => {
    await expect(devices.create('x', 'Bad Slug', '480p')).rejects.toThrow();
    await devices.create('a', 'dup-one', '720p');
    await expect(devices.create('b', 'dup-one', '720p')).rejects.toThrow();
  });
});
