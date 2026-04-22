import { join } from 'path';
import { folderHash } from './folder-hash';
import type { FrontmatterConfig } from '../../types/schedule';

export const LABEL_PREFIX = 'me.agentio.schedule';

export function plistLabel(folder: string, id: string): string {
  return `${LABEL_PREFIX}.${folderHash(folder)}-${id}`;
}

export function plistFileName(folder: string, id: string): string {
  return `${plistLabel(folder, id)}.plist`;
}

export interface PlistDict {
  Label: string;
  ProgramArguments: string[];
  RunAtLoad: boolean;
  StandardOutPath: string;
  StandardErrorPath: string;
  StartCalendarInterval?: Record<string, number> | Record<string, number>[];
  StartInterval?: number;
}

export function buildPlistDict(
  folder: string,
  id: string,
  config: FrontmatterConfig
): PlistDict {
  const label = plistLabel(folder, id);
  const logBase = join(folder, '.agentio', 'runs', id);
  const dict: PlistDict = {
    Label: label,
    ProgramArguments: [
      '/bin/zsh',
      '-lic',
      `agentio schedule run ${id} --folder ${folder} --from-launchd`,
    ],
    RunAtLoad: false,
    StandardOutPath: join(logBase, 'launchd.log'),
    StandardErrorPath: join(logBase, 'launchd.log'),
  };

  const s = config.schedule;
  switch (s.type) {
    case 'manual':
      break;
    case 'daily':
      dict.StartCalendarInterval = { Hour: s.hour ?? 0, Minute: s.minute ?? 0 };
      break;
    case 'weekly': {
      const h = s.hour ?? 0;
      const m = s.minute ?? 0;
      const days = s.weekdays ?? [];
      dict.StartCalendarInterval = days.map((ourDay) => ({
        Weekday: ourDay === 7 ? 0 : ourDay,
        Hour: h,
        Minute: m,
      }));
      break;
    }
    case 'monthly':
      dict.StartCalendarInterval = {
        Day: s.day ?? 1,
        Hour: s.hour ?? 0,
        Minute: s.minute ?? 0,
      };
      break;
    case 'interval':
      dict.StartInterval = (s.intervalMinutes ?? 60) * 60;
      break;
  }

  return dict;
}
