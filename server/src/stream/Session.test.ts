import '@/services/startup/ScheduleJobsStartupTask.js';
import { describe, expect, test, vi } from 'vitest';
import { Session } from './Session.ts';

describe('removeStaleConnections', () => {
  const run = (ageMs: number, userAgent: string) => {
    const removeConnection = vi.fn();
    const self = {
      sessionOptions: {},
      connections: () => ({ tok: { userAgent } }),
      lastHeartbeat: () => Date.now() - ageMs,
      removeConnection,
    };
    const alive = Session.prototype.removeStaleConnections.call(self as never);
    return { alive, removeConnection };
  };

  test("drops a wrapper's loopback connection after 15 s of silence", () => {
    expect(run(20_000, 'Lavf/62.12.103').alive).toEqual([]);
  });

  test('keeps a real viewer for the usual 30 s', () => {
    expect(run(20_000, 'Mozilla/5.0').alive).toEqual(['tok']);
    expect(run(40_000, 'Mozilla/5.0').alive).toEqual([]);
  });
});
