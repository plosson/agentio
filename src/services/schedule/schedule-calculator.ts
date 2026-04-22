import type { Schedule } from '../../types/schedule';

/**
 * Return the next N scheduled run times, strictly after `now`.
 * All Date math uses local time (same timezone launchd schedules against).
 */
export function nextRuns(schedule: Schedule, count: number, now: Date = new Date()): Date[] {
  const runs: Date[] = [];
  switch (schedule.type) {
    case 'manual':
      return runs;

    case 'daily': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      let candidate = atHour(now, h, m);
      if (candidate <= now) candidate = addDays(candidate, 1);
      while (runs.length < count) {
        runs.push(candidate);
        candidate = addDays(candidate, 1);
      }
      return runs;
    }

    case 'weekly': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const days = schedule.weekdays ?? [];
      let cursor = atHour(now, h, m);
      while (runs.length < count && runs.length < 500) {
        const d = cursor.getDay();
        const ourDay = d === 0 ? 7 : d;
        if (days.includes(ourDay) && cursor > now) {
          runs.push(new Date(cursor));
        }
        cursor = addDays(cursor, 1);
      }
      return runs;
    }

    case 'monthly': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const targetDay = schedule.day ?? 1;
      let year = now.getFullYear();
      let month = now.getMonth();
      while (runs.length < count) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const day = Math.min(targetDay, daysInMonth);
        const candidate = new Date(year, month, day, h, m, 0, 0);
        if (candidate > now) runs.push(candidate);
        month += 1;
        if (month > 11) { month = 0; year += 1; }
      }
      return runs;
    }

    case 'interval': {
      const mins = schedule.intervalMinutes ?? 60;
      let t = new Date(now.getTime() + mins * 60_000);
      while (runs.length < count) {
        runs.push(t);
        t = new Date(t.getTime() + mins * 60_000);
      }
      return runs;
    }
  }
}

function atHour(base: Date, h: number, m: number): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
