import type { Schedule } from '../../types/schedule';

/**
 * Return the next N scheduled run times, strictly after `now`.
 * All Date math uses local time (the daemon's local timezone).
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

/**
 * Return the most recent scheduled run time at or before `now`.
 * Returns null for manual schedules or when no previous time can be determined.
 */
export function prevRun(schedule: Schedule, now: Date = new Date()): Date | null {
  switch (schedule.type) {
    case 'manual':
      return null;

    case 'daily': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const candidate = atHour(now, h, m);
      if (candidate <= now) return candidate;
      return addDays(candidate, -1);
    }

    case 'weekly': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const days = schedule.weekdays ?? [];
      let cursor = atHour(now, h, m);
      // Walk backwards up to 7 days to find the most recent matching weekday
      for (let i = 0; i < 8; i++) {
        const d = cursor.getDay();
        const ourDay = d === 0 ? 7 : d;
        if (days.includes(ourDay) && cursor <= now) {
          return new Date(cursor);
        }
        cursor = addDays(cursor, -1);
      }
      return null;
    }

    case 'monthly': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const targetDay = schedule.day ?? 1;
      let year = now.getFullYear();
      let month = now.getMonth();
      // Check this month first
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const day = Math.min(targetDay, daysInMonth);
      const candidate = new Date(year, month, day, h, m, 0, 0);
      if (candidate <= now) return candidate;
      // Go to previous month
      month -= 1;
      if (month < 0) { month = 11; year -= 1; }
      const daysInPrevMonth = new Date(year, month + 1, 0).getDate();
      const prevDay = Math.min(targetDay, daysInPrevMonth);
      return new Date(year, month, prevDay, h, m, 0, 0);
    }

    case 'interval': {
      const mins = schedule.intervalMinutes ?? 60;
      const intervalMs = mins * 60_000;
      // Return the most recent boundary strictly before now.
      // If now is exactly on a boundary, the previous boundary is one interval back.
      const floored = Math.floor(now.getTime() / intervalMs) * intervalMs;
      const aligned = floored < now.getTime() ? floored : floored - intervalMs;
      return new Date(aligned);
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
