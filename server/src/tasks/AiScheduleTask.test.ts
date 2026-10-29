import '@/services/startup/ScheduleJobsStartupTask.js';
import { describe, expect, test, vi } from 'vitest';
import { AiScheduleTask, isBillingError } from './AiScheduleTask.ts';

function makeTask() {
  const generate = vi.fn(() =>
    Promise.reject(new Error('Your credit balance is too low')),
  );
  const channelDB = {
    getAllChannels: () =>
      Promise.resolve([{ uuid: 'c', name: 'C', number: 1 }]),
    loadAllLineupConfigs: () =>
      Promise.resolve({
        c: { lineup: { items: [], aiConfig: { prompt: 'p' } } },
      }),
    updateLineupConfig: vi.fn(),
  };
  const logger = {
    setBindings: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const task = new AiScheduleTask(
    channelDB as never,
    {} as never,
    { generate } as never,
    { get: () => Promise.resolve({ apiKey: 'k' }) } as never,
    logger as never,
  );
  return { task, generate };
}

describe('AiScheduleTask billing backoff', () => {
  test('detects billing errors', () => {
    expect(isBillingError(new Error('Your credit balance is too low'))).toBe(
      true,
    );
    expect(isBillingError(new Error('socket hang up'))).toBe(false);
  });

  test('stops calling the API after two billing errors', async () => {
    // The scheduler builds a new task for every run, so the backoff has to
    // outlive the instance.
    const runs = Array.from({ length: 4 }, () => makeTask());
    for (const { task } of runs) {
      await task.run(undefined as never);
    }
    const calls = runs.reduce((n, r) => n + r.generate.mock.calls.length, 0);
    expect(calls).toBe(2);
  });
});
