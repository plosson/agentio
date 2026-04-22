import { describe, expect, test } from 'bun:test';
import { nextRuns } from './schedule-calculator';

describe('nextRuns', () => {
  const now = new Date('2026-04-22T10:00:00Z'); // Wed

  test('manual returns empty', () => {
    expect(nextRuns({ type: 'manual' }, 5, now)).toEqual([]);
  });

  test('daily returns N future times', () => {
    const runs = nextRuns({ type: 'daily', hour: 9, minute: 0 }, 3, now);
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(r.getTime()).toBeGreaterThan(now.getTime());
      expect(r.getHours()).toBe(9);
      expect(r.getMinutes()).toBe(0);
    }
  });

  test('interval advances by N minutes', () => {
    const runs = nextRuns({ type: 'interval', intervalMinutes: 30 }, 3, now);
    expect(runs).toHaveLength(3);
    expect(runs[1].getTime() - runs[0].getTime()).toBe(30 * 60 * 1000);
  });

  test('weekly only hits configured weekdays', () => {
    const runs = nextRuns({ type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] }, 5, now);
    for (const r of runs) {
      const d = r.getDay();
      const ourDay = d === 0 ? 7 : d;
      expect([1, 3, 5]).toContain(ourDay);
      expect(r.getHours()).toBe(9);
    }
  });

  test('monthly uses the day field', () => {
    const runs = nextRuns({ type: 'monthly', day: 15, hour: 9, minute: 0 }, 2, now);
    expect(runs).toHaveLength(2);
    expect(runs[0].getDate()).toBe(15);
    expect(runs[1].getDate()).toBe(15);
  });
});
