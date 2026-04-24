import type { Schedule } from '../../types/schedule';
import { weekdayNames } from './weekdays';

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'manual': return 'Manual';
    case 'daily': return `Daily at ${fmtHM(s.hour, s.minute)}`;
    case 'weekly': return `Weekly ${weekdayNames(s.weekdays ?? [])} at ${fmtHM(s.hour, s.minute)}`;
    case 'monthly': return `Monthly on day ${s.day} at ${fmtHM(s.hour, s.minute)}`;
    case 'interval': {
      const m = s.intervalMinutes ?? 0;
      if (m < 60) return `Every ${m}m`;
      if (m % 60 === 0) return `Every ${m / 60}h`;
      return `Every ${Math.floor(m / 60)}h${m % 60}m`;
    }
  }
}

function fmtHM(h?: number, m?: number): string {
  return `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}
