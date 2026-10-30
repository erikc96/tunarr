import type { Readable, Writable } from 'node:stream';

export const DefaultMaxViewerBufferBytes = 8 * 1024 * 1024;

type Buffered = Writable & { readableLength?: number };

/**
 * Copies `source` to `dest` without ever pausing `source` (unlike pipe(), which
 * stalls every other reader of `source` while the slowest `dest` drains). A
 * `dest` that falls more than `maxBufferedBytes` behind is destroyed instead,
 * and `onDrop` hears how many bytes it was behind (so a drop is never silent).
 * Returns a function that detaches `dest`.
 */
export function fanOut(
  source: Readable,
  dest: Buffered,
  maxBufferedBytes = DefaultMaxViewerBufferBytes,
  onDrop?: (bufferedBytes: number) => void,
): () => void {
  const onData = (chunk: Buffer) => {
    if (dest.destroyed || dest.writableEnded) {
      return;
    }
    dest.write(chunk);
    const buffered = dest.writableLength + (dest.readableLength ?? 0);
    if (buffered > maxBufferedBytes) {
      detach();
      onDrop?.(buffered);
      dest.destroy(); // no error arg: nothing listens for 'error' on a viewer
    }
  };
  const onEnd = () => dest.end();
  const detach = () => {
    source.off('data', onData);
    source.off('end', onEnd);
  };
  source.on('data', onData);
  source.on('end', onEnd);
  dest.once('close', detach);
  return detach;
}
