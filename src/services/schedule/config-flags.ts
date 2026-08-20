import { CliError } from '../../utils/errors';
import type {
  FrontmatterConfig,
  Model,
  PermissionMode,
  Schedule,
  ScheduleType,
} from '../../types/schedule';
import { parseDuration } from './duration';
import { parseWeekdays } from './weekdays';

/** Raw CLI flags shared by `schedule create` (and, later, `schedule edit`). */
export interface ScheduleFlags {
  schedule?: string; // schedule type
  at?: string; // HH:MM
  hour?: string;
  minute?: string;
  weekdays?: string;
  day?: string;
  interval?: string; // duration string, e.g. "30m", "1h30m"
  model?: string;
  permissionMode?: string; // default | bypass | plan | accept-edits
  host?: string;
  command?: string;
  disabled?: boolean;
}

const SCHEDULE_TYPES: ScheduleType[] = ['manual', 'daily', 'weekly', 'monthly', 'interval'];
const MODELS: Model[] = ['opus', 'sonnet', 'haiku'];

/** CLI-friendly aliases → internal PermissionMode. */
const PERMISSION_ALIASES: Record<string, PermissionMode> = {
  default: 'default',
  bypass: 'bypassPermissions',
  bypasspermissions: 'bypassPermissions',
  plan: 'plan',
  'accept-edits': 'acceptEdits',
  acceptedits: 'acceptEdits',
};

export const PERMISSION_MODE_CHOICES = ['default', 'bypass', 'plan', 'accept-edits'] as const;

/** Parse "HH:MM" into hour/minute, validating ranges. */
export function parseAt(at: string): { hour: number; minute: number } {
  const m = at.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    throw new CliError('INVALID_PARAMS', `Invalid --at: "${at}"`, 'Use HH:MM, e.g. 09:30');
  }
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) {
    throw new CliError('INVALID_PARAMS', `Invalid time: "${at}"`, 'Hour must be 0-23, minute 0-59');
  }
  return { hour, minute };
}

/** Resolve hour/minute from --at (preferred) or --hour/--minute. Returns {} if none given. */
function timeFromFlags(flags: ScheduleFlags): { hour?: number; minute?: number } {
  if (flags.at !== undefined) return parseAt(flags.at);
  const out: { hour?: number; minute?: number } = {};
  if (flags.hour !== undefined) {
    const h = Number(flags.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new CliError('INVALID_PARAMS', `Invalid --hour: "${flags.hour}"`, 'Use an integer 0-23');
    }
    out.hour = h;
  }
  if (flags.minute !== undefined) {
    const m = Number(flags.minute);
    if (!Number.isInteger(m) || m < 0 || m > 59) {
      throw new CliError('INVALID_PARAMS', `Invalid --minute: "${flags.minute}"`, 'Use an integer 0-59');
    }
    out.minute = m;
  }
  return out;
}

/**
 * Build a Schedule for `type`, pulling only the fields relevant to that type
 * from `flags`. Missing fields are left undefined (validate with
 * `missingScheduleFields`).
 */
export function buildSchedule(type: ScheduleType, flags: ScheduleFlags): Schedule {
  const schedule: Schedule = { type };
  const { hour, minute } = timeFromFlags(flags);

  switch (type) {
    case 'manual':
      break;
    case 'daily':
      if (hour !== undefined) schedule.hour = hour;
      if (minute !== undefined) schedule.minute = minute;
      break;
    case 'weekly':
      if (flags.weekdays !== undefined) schedule.weekdays = parseWeekdays(flags.weekdays);
      if (hour !== undefined) schedule.hour = hour;
      if (minute !== undefined) schedule.minute = minute;
      break;
    case 'monthly':
      if (flags.day !== undefined) {
        const d = Number(flags.day);
        if (!Number.isInteger(d) || d < 1 || d > 31) {
          throw new CliError('INVALID_PARAMS', `Invalid --day: "${flags.day}"`, 'Use a day-of-month 1-31');
        }
        schedule.day = d;
      }
      if (hour !== undefined) schedule.hour = hour;
      if (minute !== undefined) schedule.minute = minute;
      break;
    case 'interval':
      if (flags.interval !== undefined) schedule.intervalMinutes = parseDuration(flags.interval);
      break;
  }
  return schedule;
}

/**
 * Return the list of required fields missing from `schedule` for its type.
 * Empty array means the schedule is complete and ready to fire.
 */
export function missingScheduleFields(schedule: Schedule): string[] {
  const missing: string[] = [];
  const needTime = () => {
    if (schedule.hour === undefined) missing.push('hour (--at)');
    if (schedule.minute === undefined) missing.push('minute (--at)');
  };
  switch (schedule.type) {
    case 'manual':
      break;
    case 'daily':
      needTime();
      break;
    case 'weekly':
      if (!schedule.weekdays || schedule.weekdays.length === 0) missing.push('weekdays (--weekdays)');
      needTime();
      break;
    case 'monthly':
      if (schedule.day === undefined) missing.push('day (--day)');
      needTime();
      break;
    case 'interval':
      if (schedule.intervalMinutes === undefined) missing.push('interval (--interval)');
      break;
  }
  return missing;
}

/**
 * Translate raw CLI flags into a partial FrontmatterConfig. Only keys that were
 * actually passed are set (so callers can merge over defaults or existing config).
 */
export function configFromFlags(flags: ScheduleFlags): Partial<FrontmatterConfig> {
  const out: Partial<FrontmatterConfig> = {};

  if (flags.schedule !== undefined) {
    if (!SCHEDULE_TYPES.includes(flags.schedule as ScheduleType)) {
      throw new CliError(
        'INVALID_PARAMS',
        `Invalid --schedule: "${flags.schedule}"`,
        `Use one of: ${SCHEDULE_TYPES.join(', ')}`,
      );
    }
    out.schedule = buildSchedule(flags.schedule as ScheduleType, flags);
  }

  if (flags.model !== undefined) {
    if (!MODELS.includes(flags.model as Model)) {
      throw new CliError('INVALID_PARAMS', `Invalid --model: "${flags.model}"`, `Use one of: ${MODELS.join(', ')}`);
    }
    out.model = flags.model as Model;
  }

  if (flags.permissionMode !== undefined) {
    const mode = PERMISSION_ALIASES[flags.permissionMode.toLowerCase()];
    if (!mode) {
      throw new CliError(
        'INVALID_PARAMS',
        `Invalid --permission-mode: "${flags.permissionMode}"`,
        `Use one of: ${PERMISSION_MODE_CHOICES.join(', ')}`,
      );
    }
    out.permissionMode = mode;
  }

  if (flags.host !== undefined) out.host = flags.host;
  if (flags.command !== undefined) out.command = flags.command;
  if (flags.disabled) out.enabled = false;

  return out;
}
