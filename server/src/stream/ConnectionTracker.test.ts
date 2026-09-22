import { describe, expect, test } from 'vitest';
import { sessionsToEvict } from './ConnectionTracker.ts';

describe('sessionsToEvict', () => {
  test('keeps up to max idle sessions', () => {
    const idle = new Map([
      ['a', 100],
      ['b', 200],
    ]);
    expect(sessionsToEvict(idle, 2)).toEqual([]);
  });

  test('evicts the longest-idle sessions beyond max', () => {
    const idle = new Map([
      ['newest', 300],
      ['oldest', 100],
      ['middle', 200],
    ]);
    expect(sessionsToEvict(idle, 1)).toEqual(['oldest', 'middle']);
  });

  test('max of 0 evicts everything', () => {
    expect(sessionsToEvict(new Map([['a', 1]]), 0)).toEqual(['a']);
  });
});
