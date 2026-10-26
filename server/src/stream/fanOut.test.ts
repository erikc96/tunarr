import { PassThrough, Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { fanOut } from './fanOut.ts';

describe('fanOut', () => {
  test('destroys a slow viewer without stalling the others', () => {
    const source = new PassThrough();
    const slow = new PassThrough({ highWaterMark: 16 });
    const fast = new PassThrough();
    fanOut(source, slow, 100);
    fanOut(source, fast, 100);
    const got: Buffer[] = [];
    fast.on('data', (c: Buffer) => got.push(c));

    for (let i = 0; i < 20; i++) {
      source.write(Buffer.alloc(50)); // slow never reads
    }
    expect(slow.destroyed).toBe(true);
    expect(fast.destroyed).toBe(false);
    expect(Buffer.concat(got).length).toBe(1000);
  });

  test('ends the viewer when the source ends and detaches on close', async () => {
    const source = Readable.from([Buffer.from('a'), Buffer.from('b')]);
    const dest = new PassThrough();
    fanOut(source, dest);
    const chunks: Buffer[] = [];
    for await (const c of dest) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('ab');
    expect(source.listenerCount('data')).toBe(0);
  });
});
