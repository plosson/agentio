import { Command } from 'commander';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { select, input } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { isInteractive } from '../utils/interactive';
import {
  mergeConfig,
  parseFrontmatter,
  serializeFrontmatter,
} from '../services/schedule/frontmatter';
import { parseDuration } from '../services/schedule/duration';
import { parseWeekdays } from '../services/schedule/weekdays';
import { installPlist } from '../services/schedule/launchd';
import type {
  FrontmatterConfig,
  Model,
  PermissionMode,
  Schedule,
  ScheduleType,
  SessionMode,
} from '../types/schedule';

export interface AddFlags {
  folder?: string;
  schedule?: string;
  at?: string;
  hour?: string;
  minute?: string;
  weekdays?: string;
  day?: string;
  interval?: string;
  model?: string;
  permissionMode?: string;
  sessionMode?: string;
  command?: string;
  disabled?: boolean;
  yes?: boolean;
}

const VALID_SCHEDULE_TYPES: ScheduleType[] = ['manual', 'daily', 'weekly', 'monthly', 'interval'];
const VALID_MODELS: Model[] = ['opus', 'sonnet', 'haiku'];
const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'bypassPermissions', 'plan', 'acceptEdits'];
const VALID_SESSION_MODES: SessionMode[] = ['new', 'resume', 'fork'];

/** Map --permission-mode CLI flag ("bypass"/"accept-edits") to frontmatter values. */
function mapPermissionMode(flag: string): PermissionMode {
  switch (flag) {
    case 'bypass': return 'bypassPermissions';
    case 'accept-edits': return 'acceptEdits';
    case 'default':
    case 'bypassPermissions':
    case 'plan':
    case 'acceptEdits': return flag as PermissionMode;
    default:
      throw new CliError('INVALID_PARAMS', `Invalid --permission-mode: "${flag}"`,
        'Use one of: default, bypass, plan, accept-edits');
  }
}

/** Pure: build a Schedule from flags. Throws CliError on bad input. */
export function scheduleFromFlags(flags: AddFlags): Schedule | undefined {
  if (!flags.schedule) return undefined;
  const type = flags.schedule as ScheduleType;
  if (!VALID_SCHEDULE_TYPES.includes(type)) {
    throw new CliError('INVALID_PARAMS', `Invalid --schedule: "${flags.schedule}"`,
      `Use one of: ${VALID_SCHEDULE_TYPES.join(', ')}`);
  }
  const parseHM = (): { hour: number; minute: number } | null => {
    if (flags.at) {
      const m = flags.at.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) throw new CliError('INVALID_PARAMS', `Invalid --at: "${flags.at}"`, 'Expected HH:MM');
      return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
    }
    if (flags.hour !== undefined) {
      return { hour: parseInt(flags.hour, 10), minute: flags.minute ? parseInt(flags.minute, 10) : 0 };
    }
    return null;
  };

  switch (type) {
    case 'manual':
      return { type };
    case 'daily': {
      const hm = parseHM();
      if (!hm) return { type };
      return { type, hour: hm.hour, minute: hm.minute };
    }
    case 'weekly': {
      const hm = parseHM();
      const weekdays = flags.weekdays ? parseWeekdays(flags.weekdays) : undefined;
      return {
        type,
        ...(hm ? { hour: hm.hour, minute: hm.minute } : {}),
        ...(weekdays ? { weekdays } : {}),
      };
    }
    case 'monthly': {
      const hm = parseHM();
      const day = flags.day ? parseInt(flags.day, 10) : undefined;
      return {
        type,
        ...(hm ? { hour: hm.hour, minute: hm.minute } : {}),
        ...(day !== undefined ? { day } : {}),
      };
    }
    case 'interval': {
      const intervalMinutes = flags.interval ? parseDuration(flags.interval) : undefined;
      return { type, ...(intervalMinutes !== undefined ? { intervalMinutes } : {}) };
    }
  }
}

/** Pure: partial FrontmatterConfig from CLI flags. */
export function configFromFlags(flags: AddFlags): Partial<FrontmatterConfig> {
  const partial: Partial<FrontmatterConfig> = {};
  const schedule = scheduleFromFlags(flags);
  if (schedule) partial.schedule = schedule;
  if (flags.model) {
    if (!VALID_MODELS.includes(flags.model as Model)) {
      throw new CliError('INVALID_PARAMS', `Invalid --model: "${flags.model}"`,
        `Use one of: ${VALID_MODELS.join(', ')}`);
    }
    partial.model = flags.model as Model;
  }
  if (flags.permissionMode) partial.permissionMode = mapPermissionMode(flags.permissionMode);
  if (flags.sessionMode) {
    if (!VALID_SESSION_MODES.includes(flags.sessionMode as SessionMode)) {
      throw new CliError('INVALID_PARAMS', `Invalid --session-mode: "${flags.sessionMode}"`,
        `Use one of: ${VALID_SESSION_MODES.join(', ')}`);
    }
    partial.sessionMode = flags.sessionMode as SessionMode;
  }
  if (flags.command) partial.command = flags.command;
  if (flags.disabled) partial.enabled = false;
  return partial;
}

/** Required fields of a schedule by type. */
function missingScheduleFields(s: Schedule | undefined): string[] {
  if (!s) return ['schedule'];
  switch (s.type) {
    case 'manual': return [];
    case 'daily':
      return (s.hour === undefined || s.minute === undefined) ? ['hour', 'minute'] : [];
    case 'weekly': {
      const missing: string[] = [];
      if (!s.weekdays || s.weekdays.length === 0) missing.push('weekdays');
      if (s.hour === undefined || s.minute === undefined) missing.push('hour', 'minute');
      return missing;
    }
    case 'monthly': {
      const missing: string[] = [];
      if (s.day === undefined) missing.push('day');
      if (s.hour === undefined || s.minute === undefined) missing.push('hour', 'minute');
      return missing;
    }
    case 'interval':
      return s.intervalMinutes === undefined ? ['intervalMinutes'] : [];
  }
}

async function promptMissing(
  partial: Partial<FrontmatterConfig>,
  missing: string[]
): Promise<Partial<FrontmatterConfig>> {
  const out: Partial<FrontmatterConfig> = { ...partial };
  const s: Schedule = { ...(out.schedule ?? { type: 'manual' }) } as Schedule;

  if (missing.includes('schedule')) {
    s.type = await select({
      message: 'Schedule type:',
      choices: VALID_SCHEDULE_TYPES.map((t) => ({ name: t, value: t })),
    });
  }
  if (missing.includes('weekdays')) {
    const raw = await input({ message: 'Weekdays (e.g. mon,wed,fri):' });
    s.weekdays = parseWeekdays(raw);
  }
  if (missing.includes('day')) {
    const raw = await input({ message: 'Day of month (1-31):' });
    s.day = parseInt(raw, 10);
  }
  if (missing.includes('hour') || missing.includes('minute')) {
    const raw = await input({ message: 'Time of day (HH:MM):', default: '09:00' });
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new CliError('INVALID_PARAMS', `Invalid time: "${raw}"`, 'Expected HH:MM');
    s.hour = parseInt(m[1], 10);
    s.minute = parseInt(m[2], 10);
  }
  if (missing.includes('intervalMinutes')) {
    const raw = await input({ message: 'Interval (e.g. 30m, 2h, 1h30m):' });
    s.intervalMinutes = parseDuration(raw);
  }
  out.schedule = s;
  return out;
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Schedule prompts to run on a cron-like schedule via launchd');

  schedule.command('add').description('Add or update a schedule (writes frontmatter + installs plist)')
    .argument('<file>', 'Path to the .run.md file (must end in .run.md)')
    .option('--folder <path>', 'Folder containing the file (default: CWD)')
    .option('--schedule <type>', 'manual | daily | weekly | monthly | interval')
    .option('--at <HH:MM>', 'Time of day shortcut for --hour/--minute')
    .option('--hour <n>', 'Hour 0-23')
    .option('--minute <n>', 'Minute 0-59')
    .option('--weekdays <list>', 'Weekly: mon,wed,fri or 1,3,5')
    .option('--day <n>', 'Monthly: day of month 1-31')
    .option('--interval <dur>', 'Interval: 30m, 2h, 1h30m')
    .option('--model <m>', 'opus | sonnet | haiku')
    .option('--permission-mode <m>', 'default | bypass | plan | accept-edits')
    .option('--session-mode <m>', 'new | resume | fork')
    .option('--command <cmd>', 'Command override (ignores model/permissionMode/sessionMode)')
    .option('--disabled', 'Create with enabled: false')
    .option('-y, --yes', 'Non-interactive; error if required flags missing')
    .action(async (file: string, opts: AddFlags) => {
      try {
        if (!file.endsWith('.run.md')) {
          throw new CliError('INVALID_PARAMS', `File must end in .run.md: "${file}"`);
        }
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const filePath = isAbsolute(file) ? file : resolve(folder, file);

        let existingBody = '# TODO: write your prompt here\n';
        let existingConfig: Partial<FrontmatterConfig> = {};
        if (existsSync(filePath)) {
          const raw = await readFile(filePath, 'utf-8');
          const parsed = parseFrontmatter(raw);
          existingConfig = parsed.config;
          if (parsed.body.trim()) existingBody = parsed.body;
        }

        const override = configFromFlags(opts);
        let merged: Partial<FrontmatterConfig> = {
          ...existingConfig,
          ...override,
          ...(override.schedule ? { schedule: override.schedule } : existingConfig.schedule ? { schedule: existingConfig.schedule } : {}),
        };

        const missing = missingScheduleFields(merged.schedule);
        if (missing.length > 0) {
          if (opts.yes || !isInteractive()) {
            throw new CliError('INVALID_PARAMS',
              `Missing required fields: ${missing.join(', ')}`,
              'Provide via flags or run interactively (no -y)');
          }
          merged = await promptMissing(merged, missing);
        }

        const finalConfig: FrontmatterConfig = mergeConfig({}, merged);

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, serializeFrontmatter(finalConfig, existingBody));

        const id = file.split('/').pop()!.slice(0, -'.run.md'.length);
        installPlist(folder, id, finalConfig);

        console.log(`Installed schedule "${id}" in ${folder}`);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('list').description('List installed schedules')
    .option('--folder <path>', 'Filter to one folder')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('sync').description('Reconcile launchd plists with *.run.md files')
    .option('--folder <path>', 'Folder to sync (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('remove').description('Delete a schedule and uninstall its plist')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('--from-launchd', 'Internal: flag set by launchd-triggered invocations')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('show').description('Show a schedule and next run times')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('runs').description('List past runs for a schedule')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });
}
