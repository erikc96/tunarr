import '@/services/startup/ScheduleJobsStartupTask.js';
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { concatWrapperTypes, SessionManager } from './SessionManager.ts';
import type { SessionType } from './Session.ts';

class FakeSession extends EventEmitter {
  state = 'started';
  started = true;
  hasError = false;
  stop = vi.fn(() => {
    if (this.state !== 'stopped') {
      this.state = 'stopped';
      this.emit('stop');
    }
    return Promise.resolve();
  });
  constructor(
    readonly id: string,
    readonly sessionType: SessionType,
    private conns: Record<string, { userAgent?: string }> = {},
  ) {
    super();
  }
  get keyObj() {
    return { id: this.id, sessionType: this.sessionType };
  }
  connections() {
    return this.conns;
  }
  numConnections() {
    return Object.keys(this.conns).length;
  }
  isConcatSession() {
    return this.sessionType.includes('_concat');
  }
}

function setup(maxLingering = 0) {
  const logger = { debug: vi.fn(), error: vi.fn() };
  const settings = {
    ffmpegSettings: () => ({
      idleSessionLingerSeconds: 600,
      maxLingeringSessions: maxLingering,
      transcodeDirectory: '/tmp',
    }),
  };
  const channelDB = {
    getChannelOrm: () => Promise.resolve({ uuid: 'c1', transcodeConfig: {} }),
  };
  const sessions: Record<string, FakeSession> = {};
  const mk = (t: SessionType, conns = {}) =>
    (sessions[t] = new FakeSession('c1', t, conns));
  const mgr = new SessionManager(
    logger as never,
    channelDB as never,
    { resumeChannel: vi.fn(), pauseChannel: vi.fn() } as never,
    (() => mk('hls')) as never,
    (() => mk('hls_slower')) as never,
    ((_c: unknown, o: { sessionType: SessionType }) =>
      mk(o.sessionType)) as never,
    { push: vi.fn() } as never,
    settings as never,
  );
  return { mgr, sessions };
}

const conn = { userAgent: 'x', ip: '1' } as never;

describe('concatWrapperTypes', () => {
  test('lists plain, low and fire wrappers', () => {
    expect(concatWrapperTypes('hls')).toEqual([
      'hls_concat',
      'hls_concat_low',
      'hls_concat_fire',
    ]);
  });
});

describe('SessionManager idle on wrapper stop', () => {
  test('stopping the last wrapper evicts the idle transcode', async () => {
    const { mgr, sessions } = setup(0);
    await mgr.getOrCreateHlsSession('c1', 't', conn);
    await mgr.getOrCreateConcatSession('c1', 't', conn, {
      sessionType: 'hls_concat_fire',
    } as never);
    await sessions['hls_concat_fire']!.stop();
    expect(sessions['hls']!.stop).toHaveBeenCalled();
    expect(mgr.getSession('c1', 'hls')).toBeUndefined();
  });

  test('keeps the transcode while another wrapper remains', async () => {
    const { mgr, sessions } = setup(0);
    await mgr.getOrCreateHlsSession('c1', 't', conn);
    await mgr.getOrCreateConcatSession('c1', 't', conn, {
      sessionType: 'hls_concat_fire',
    } as never);
    await mgr.getOrCreateConcatSession('c1', 't2', conn, {
      sessionType: 'hls_concat_low',
    } as never);
    await sessions['hls_concat_fire']!.stop();
    expect(sessions['hls']!.stop).not.toHaveBeenCalled();
  });

  test('shutting down the transcode stops _low and _fire wrappers', async () => {
    const { mgr, sessions } = setup(2);
    await mgr.getOrCreateHlsSession('c1', 't', conn);
    await mgr.getOrCreateConcatSession('c1', 't', conn, {
      sessionType: 'hls_concat_low',
    } as never);
    await mgr.getOrCreateConcatSession('c1', 't', conn, {
      sessionType: 'hls_concat_fire',
    } as never);
    await sessions['hls']!.stop();
    expect(sessions['hls_concat_low']!.stop).toHaveBeenCalled();
    expect(sessions['hls_concat_fire']!.stop).toHaveBeenCalled();
  });
});
