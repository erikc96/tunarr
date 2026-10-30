import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ScheduledTask } from './ScheduledTask.ts';
import { SimpleTask } from './Task.ts';

class CountingTask extends SimpleTask {
  static runs = 0;
  static release: Array<() => void> = [];
  static hold = false;

  protected runInternal(): Promise<void> {
    CountingTask.runs++;
    if (!CountingTask.hold) {
      return Promise.resolve();
    }
    return new Promise((resolve) => CountingTask.release.push(resolve));
  }
}

describe('ScheduledTask.runSoon', () => {
  let task: ScheduledTask<typeof CountingTask.prototype.schema, void>;

  beforeEach(() => {
    vi.useFakeTimers();
    CountingTask.runs = 0;
    CountingTask.release = [];
    CountingTask.hold = false;
    // A yearly rule so the cron never fires during the test.
    task = new ScheduledTask(
      CountingTask,
      '0 0 0 1 1 *',
      () => new CountingTask(),
      undefined,
    );
  });

  afterEach(() => {
    task.cancel(false);
    vi.useRealTimers();
  });

  test('a burst of triggers runs the job once, after the delay', async () => {
    for (let i = 0; i < 5; i++) {
      task.runSoon(1_000);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(CountingTask.runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(CountingTask.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(CountingTask.runs).toBe(1);
  });

  test('triggers during a run get exactly one follow-up run', async () => {
    CountingTask.hold = true;
    task.runSoon(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(CountingTask.runs).toBe(1);
    expect(task.running).toBe(true);

    task.runSoon(1_000);
    task.runSoon(1_000);
    task.runSoon(1_000);
    CountingTask.hold = false;
    CountingTask.release.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(CountingTask.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(CountingTask.runs).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(CountingTask.runs).toBe(2);
  });

  test('a trigger after the run finished schedules a new run', async () => {
    task.runSoon(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    task.runSoon(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(CountingTask.runs).toBe(2);
  });
});
