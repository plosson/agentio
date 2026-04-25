import { Command } from 'commander';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import plist from 'plist';
import { select, input } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { isInteractive } from '../utils/interactive';
import {
  mergeConfig,
  parseFrontmatter,
  serializeFrontmatter,
} from '../services/schedule/frontmatter';
import { parseDuration } from '../services/schedule/duration';
import { parseWeekdays, weekdayNames } from '../services/schedule/weekdays';
import { describeSchedule } from '../services/schedule/describe';
import { walkRunFiles } from '../services/schedule/walker';
import { runSchedule } from '../services/schedule/runner';
import { nextRuns } from '../services/schedule/schedule-calculator';
import { listRuns } from '../services/schedule/runs';
import { getCurrentHost, hostMatches } from '../services/schedule/host';
import { scanWatchedFolders } from '../daemon/scheduler-core';
import type { SchedulerJobView } from '../daemon/scheduler';
import { loadConfig, saveConfig } from '../config/config-manager';
import { addWatchedFolder, removeWatchedFolder } from './schedule-watch';
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
  host?: string;
  disabled?: boolean;
  enable?: boolean;
  yes?: boolean;
}

const VALID_SCHEDULE_TYPES: ScheduleType[] = ['manual', 'daily', 'weekly', 'monthly', 'interval'];
const VALID_MODELS: Model[] = ['opus', 'sonnet', 'haiku'];
const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'bypassPermissions', 'plan', 'acceptEdits'];
const VALID_SESSION_MODES: SessionMode[] = ['new', 'resume', 'fork'];

export type ConfigField =
  | 'schedule'
  | 'weekdays'
  | 'day'
  | 'hour'
  | 'minute'
  | 'intervalMinutes'
  | 'model'
  | 'permissionMode'
  | 'sessionMode'
  | 'command'
  | 'host'
  | 'enabled';

export const ALL_EDITABLE_FIELDS: readonly ConfigField[] = [
  'schedule', 'weekdays', 'day', 'hour', 'minute', 'intervalMinutes',
  'model', 'permissionMode', 'sessionMode', 'command', 'host', 'enabled',
];

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

/**
 * Rebuild a Schedule for a new type, carrying over fields that still apply
 * and dropping irrelevant ones.
 */
export function applyScheduleType(current: Schedule, newType: ScheduleType): Schedule {
  switch (newType) {
    case 'manual':
      return { type: 'manual' };
    case 'daily':
      return {
        type: 'daily',
        ...(current.hour !== undefined ? { hour: current.hour } : {}),
        ...(current.minute !== undefined ? { minute: current.minute } : {}),
      };
    case 'weekly':
      return {
        type: 'weekly',
        ...(current.hour !== undefined ? { hour: current.hour } : {}),
        ...(current.minute !== undefined ? { minute: current.minute } : {}),
        ...(current.weekdays && current.weekdays.length > 0 ? { weekdays: current.weekdays } : {}),
      };
    case 'monthly':
      return {
        type: 'monthly',
        ...(current.hour !== undefined ? { hour: current.hour } : {}),
        ...(current.minute !== undefined ? { minute: current.minute } : {}),
        ...(current.day !== undefined ? { day: current.day } : {}),
      };
    case 'interval':
      return {
        type: 'interval',
        ...(current.intervalMinutes !== undefined ? { intervalMinutes: current.intervalMinutes } : {}),
      };
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
  if (flags.host) partial.host = flags.host;
  if (flags.disabled && flags.enable) {
    throw new CliError(
      'INVALID_PARAMS',
      '--enable and --disabled cannot be used together',
      'Use --enable to re-enable, or --disabled to disable — not both'
    );
  }
  if (flags.disabled) partial.enabled = false;
  if (flags.enable) partial.enabled = true;
  return partial;
}

/** Required fields of a schedule by type. */
function missingScheduleFields(s: Schedule | undefined): ConfigField[] {
  if (!s) return ['schedule'];
  switch (s.type) {
    case 'manual': return [];
    case 'daily':
      return (s.hour === undefined || s.minute === undefined) ? ['hour', 'minute'] : [];
    case 'weekly': {
      const missing: ConfigField[] = [];
      if (!s.weekdays || s.weekdays.length === 0) missing.push('weekdays');
      if (s.hour === undefined || s.minute === undefined) missing.push('hour', 'minute');
      return missing;
    }
    case 'monthly': {
      const missing: ConfigField[] = [];
      if (s.day === undefined) missing.push('day');
      if (s.hour === undefined || s.minute === undefined) missing.push('hour', 'minute');
      return missing;
    }
    case 'interval':
      return s.intervalMinutes === undefined ? ['intervalMinutes'] : [];
  }
}

async function promptConfig(
  partial: Partial<FrontmatterConfig>,
  fields: readonly ConfigField[]
): Promise<Partial<FrontmatterConfig>> {
  const fieldSet = new Set(fields);
  const out: Partial<FrontmatterConfig> = { ...partial };
  let s: Schedule = { ...(out.schedule ?? { type: 'manual' }) } as Schedule;

  if (fieldSet.has('schedule')) {
    const newType = await select({
      message: 'Schedule type:',
      choices: VALID_SCHEDULE_TYPES.map((t) => ({ name: t, value: t })),
      default: s.type,
    });
    s = applyScheduleType(s, newType);
  }

  // Schedule sub-fields are only prompted when relevant for the current type.
  const needsHM = s.type === 'daily' || s.type === 'weekly' || s.type === 'monthly';
  const needsWeekdays = s.type === 'weekly';
  const needsDay = s.type === 'monthly';
  const needsInterval = s.type === 'interval';

  if (needsWeekdays && fieldSet.has('weekdays')) {
    const current = s.weekdays ? formatWeekdaysShort(s.weekdays) : '';
    const raw = await input({ message: 'Weekdays (e.g. mon,wed,fri):', default: current });
    s.weekdays = parseWeekdays(raw);
  }
  if (needsDay && fieldSet.has('day')) {
    const current = s.day !== undefined ? String(s.day) : '';
    const raw = await input({ message: 'Day of month (1-31):', default: current });
    s.day = parseInt(raw, 10);
  }
  if (needsHM && (fieldSet.has('hour') || fieldSet.has('minute'))) {
    const hDef = s.hour !== undefined ? String(s.hour).padStart(2, '0') : '09';
    const mDef = s.minute !== undefined ? String(s.minute).padStart(2, '0') : '00';
    const raw = await input({ message: 'Time of day (HH:MM):', default: `${hDef}:${mDef}` });
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new CliError('INVALID_PARAMS', `Invalid time: "${raw}"`, 'Expected HH:MM');
    s.hour = parseInt(m[1], 10);
    s.minute = parseInt(m[2], 10);
  }
  if (needsInterval && fieldSet.has('intervalMinutes')) {
    const currentMinutes = s.intervalMinutes ?? 0;
    const hh = Math.floor(currentMinutes / 60);
    const mm = currentMinutes % 60;
    const currentDur = hh > 0 && mm > 0 ? `${hh}h${mm}m` : hh > 0 ? `${hh}h` : `${mm}m`;
    const raw = await input({
      message: 'Interval (e.g. 30m, 2h, 1h30m):',
      default: currentMinutes > 0 ? currentDur : '30m',
    });
    s.intervalMinutes = parseDuration(raw);
  }
  out.schedule = s;

  if (fieldSet.has('model')) {
    out.model = await select({
      message: 'Model:',
      choices: VALID_MODELS.map((m) => ({ name: m, value: m })),
      default: out.model ?? 'sonnet',
    });
  }
  if (fieldSet.has('permissionMode')) {
    out.permissionMode = await select({
      message: 'Permission mode:',
      choices: VALID_PERMISSION_MODES.map((m) => ({ name: m, value: m })),
      default: out.permissionMode ?? 'bypassPermissions',
    });
  }
  if (fieldSet.has('sessionMode')) {
    out.sessionMode = await select({
      message: 'Session mode:',
      choices: VALID_SESSION_MODES.map((m) => ({ name: m, value: m })),
      default: out.sessionMode ?? 'new',
    });
  }
  if (fieldSet.has('command')) {
    const raw = await input({
      message: 'Command override (empty to clear):',
      default: out.command ?? '',
    });
    if (raw.trim()) out.command = raw.trim();
    else delete out.command;
  }
  if (fieldSet.has('host')) {
    const raw = await input({
      message: 'Pin to host (empty to clear):',
      default: out.host ?? '',
    });
    if (raw.trim()) out.host = raw.trim();
    else delete out.host;
  }
  if (fieldSet.has('enabled')) {
    const enabled = await select({
      message: 'Enabled?',
      choices: [
        { name: 'yes', value: true },
        { name: 'no', value: false },
      ],
      default: out.enabled ?? true,
    });
    out.enabled = enabled;
  }

  return out;
}

const WEEKDAY_SHORT = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function formatWeekdaysShort(nums: number[]): string {
  return nums.map((n) => WEEKDAY_SHORT[n] ?? String(n)).join(',');
}

/** Replace $HOME prefix with `~` for display. */
export function abbrHome(path: string, home: string = homedir()): string {
  if (path === home) return '~';
  if (path.startsWith(home + '/')) return '~' + path.slice(home.length);
  return path;
}


function renderJobs(jobs: Array<{
  folder: string; id: string; schedule: string;
  enabled: boolean; nextRun: string; isRunning?: boolean;
}>, filterFolder?: string): void {
  const filtered = filterFolder
    ? jobs.filter((j) => j.folder === resolve(filterFolder))
    : jobs;
  if (filtered.length === 0) {
    console.log('No schedules.');
    console.log('Add one with: agentio schedule add <folder>/<id>.run.md');
    return;
  }
  const widths = {
    id: Math.max('ID'.length, ...filtered.map((r) => r.id.length)),
    folder: Math.max('FOLDER'.length, ...filtered.map((r) => abbrHome(r.folder).length)),
    sched: Math.max('SCHEDULE'.length, ...filtered.map((r) => r.schedule.length)),
  };
  console.log(`${'ID'.padEnd(widths.id)}  ${'FOLDER'.padEnd(widths.folder)}  ${'SCHEDULE'.padEnd(widths.sched)}  NEXT`);
  for (const r of filtered) {
    const run = r.isRunning ? ' [running]' : '';
    console.log(`${r.id.padEnd(widths.id)}  ${abbrHome(r.folder).padEnd(widths.folder)}  ${r.schedule.padEnd(widths.sched)}  ${r.nextRun}${run}`);
  }
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Schedule prompts to run on a cron-like schedule (executed by the agentio daemon)');

  schedule.command('add').description('Add or update a schedule (writes frontmatter to a .run.md file)')
    .argument('<file-or-id>', 'Path to a .run.md file, or a bare id (creates <folder>/<id>.run.md)')
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
    .option('--host <name>', 'Pin schedule to a specific hostname; skipped on other machines')
    .option('--disabled', 'Create with enabled: false')
    .option('-y, --yes', 'Non-interactive; error if required flags missing')
    .action(async (file: string, opts: AddFlags) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        let filePath: string;
        if (file.endsWith('.run.md')) {
          filePath = isAbsolute(file) ? file : resolve(folder, file);
        } else {
          // Treat as id
          filePath = resolve(folder, `${file}.run.md`);
        }

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
          merged = await promptConfig(merged, missing);
        }

        const finalConfig: FrontmatterConfig = mergeConfig({}, merged);

        if (!finalConfig.host) {
          finalConfig.host = getCurrentHost();
        }

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, serializeFrontmatter(finalConfig, existingBody));

        console.log(`Saved ${abbrHome(filePath)}.`);
        console.log(`  schedule: ${describeSchedule(finalConfig.schedule)}`);
        console.log(`  enabled:  ${finalConfig.enabled ? 'yes' : 'no'}`);
        if (finalConfig.host) console.log(`  host:     ${finalConfig.host}`);

        // Hint: is this folder already watched?
        const cfg = await loadConfig();
        const watched = cfg.daemon?.scheduler?.watchedFolders ?? [];
        if (!watched.find((w) => w.path === folder)) {
          console.log('\nTo have the daemon fire this schedule, run:');
          console.log(`  agentio schedule watch ${abbrHome(folder)}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('edit').description('Edit an existing schedule (walk-through editor)')
    .argument('<id>', 'Schedule id')
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
    .option('--host <name>', 'Pin schedule to a specific hostname; skipped on other machines')
    .option('--disabled', 'Set enabled: false')
    .option('--enable', 'Set enabled: true')
    .option('-y, --yes', 'Non-interactive; apply flags only, error if required fields missing')
    .action(async (id: string, opts: AddFlags) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length === 0) {
          throw new CliError('NOT_FOUND', `No .run.md file found for id "${id}" under ${folder}`,
            'Check the id (agentio schedule list) or pass --folder');
        }
        if (matches.length > 1) {
          throw new CliError('INVALID_PARAMS',
            `Multiple files match id "${id}": ${matches.map((m) => m.path).join(', ')}`);
        }
        const filePath = matches[0].path;

        const raw = await readFile(filePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const existingConfig: Partial<FrontmatterConfig> = parsed.config;

        const override = configFromFlags(opts);
        let merged: Partial<FrontmatterConfig> = {
          ...existingConfig,
          ...override,
          ...(override.schedule
            ? { schedule: override.schedule }
            : existingConfig.schedule
            ? { schedule: existingConfig.schedule }
            : {}),
        };

        if (opts.yes || !isInteractive()) {
          const missing = missingScheduleFields(merged.schedule);
          if (missing.length > 0) {
            throw new CliError('INVALID_PARAMS',
              `Missing required fields: ${missing.join(', ')}`,
              'Provide via flags or run interactively (no -y)');
          }
        } else {
          merged = await promptConfig(merged, ALL_EDITABLE_FIELDS);
        }

        const finalConfig: FrontmatterConfig = mergeConfig({}, merged);

        if (!finalConfig.host) {
          finalConfig.host = getCurrentHost();
        }

        await writeFile(filePath, serializeFrontmatter(finalConfig, parsed.body || '# TODO\n'));

        console.log(`Saved ${abbrHome(filePath)}.`);
        console.log(`  schedule: ${describeSchedule(finalConfig.schedule)}`);
        console.log(`  enabled:  ${finalConfig.enabled ? 'yes' : 'no'}`);
        if (finalConfig.host) console.log(`  host:     ${finalConfig.host}`);

        // Hint: is this folder already watched?
        const cfg = await loadConfig();
        const watched = cfg.daemon?.scheduler?.watchedFolders ?? [];
        if (!watched.find((w) => w.path === folder)) {
          console.log('\nTo have the daemon fire this schedule, run:');
          console.log(`  agentio schedule watch ${abbrHome(folder)}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  const printWatchedFolders = (folders: { path: string; host?: string }[]): void => {
    if (folders.length === 0) {
      console.log('No folders watched.');
      console.log('Add one with: agentio schedule watch <folder>');
      return;
    }
    console.log('Watched folders:');
    for (const f of folders) {
      const pin = f.host ? ` (pinned to ${f.host})` : '';
      console.log(`  ${abbrHome(f.path)}${pin}`);
    }
  };

  schedule.command('list').description('List watched folders and scheduled tasks')
    .option('--folder <path>', 'Filter schedules to one folder')
    .option('--folders', 'Show watched folders only (no schedules)')
    .action(async (opts: { folder?: string; folders?: boolean }) => {
      try {
        const config = await loadConfig();
        const folders = config.daemon?.scheduler?.watchedFolders ?? [];

        printWatchedFolders(folders);

        if (opts.folders || folders.length === 0) return;

        const apiKey = config.daemon?.apiKey;
        const port = config.daemon?.server?.port ?? 7890;

        console.log('');
        console.log('Schedules:');

        if (apiKey) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/scheduler/list`, {
              headers: { 'X-API-Key': apiKey },
              signal: AbortSignal.timeout(1500),
            });
            if (res.ok) {
              const { jobs } = await res.json() as { jobs: SchedulerJobView[] };
              renderJobs(jobs, opts.folder);
              return;
            }
          } catch { /* fall through to FS mode */ }
        }

        const now = new Date();
        const host = getCurrentHost();
        const jobs = scanWatchedFolders(folders, host, now).map((j) => ({
          folder: j.folder,
          id: j.id,
          schedule: describeSchedule(j.config.schedule),
          enabled: j.config.enabled,
          nextRun: j.nextRun.toISOString(),
          isRunning: false,
        }));
        renderJobs(jobs, opts.folder);
        console.log('\n(daemon not running — showing filesystem view)');
      } catch (e) {
        handleError(e);
      }
    });

  const checkAction = async (opts: { folder?: string; yes?: boolean }) => {
    try {
      const folder = opts.folder ? resolve(opts.folder) : process.cwd();

      // 1. Walk for *.run.md files
      const files = walkRunFiles(folder);

      // 2. Collision check
      const byId = new Map<string, string[]>();
      for (const f of files) {
        const arr = byId.get(f.id) ?? [];
        arr.push(f.path);
        byId.set(f.id, arr);
      }
      const collisions = [...byId.entries()].filter(([, v]) => v.length > 1);
      if (collisions.length > 0) {
        const lines = collisions.map(([id, paths]) => `  "${id}":\n    ${paths.join('\n    ')}`);
        throw new CliError('INVALID_PARAMS',
          `Multiple .run.md files share the same id:\n${lines.join('\n')}`,
          'Rename one of the files');
      }

      // 3. Ensure .agentio/.gitignore exists (first-time scaffolding)
      if (files.length > 0) {
        const giPath = resolve(folder, '.agentio', '.gitignore');
        await mkdir(dirname(giPath), { recursive: true });
        if (!existsSync(giPath)) {
          await writeFile(giPath, 'runs/\nstate.json\n');
        }
      }

      // 4. Build desired configs, prompting for incomplete files
      const desired = new Map<string, { config: FrontmatterConfig; body: string; filePath: string }>();
      for (const f of files) {
        const raw = await readFile(f.path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        let config = parsed.config as Partial<FrontmatterConfig>;
        const missing = missingScheduleFields(config.schedule);
        if (!config.host) missing.push('host' as ConfigField);
        if (missing.length > 0) {
          if (opts.yes || !isInteractive()) {
            throw new CliError('INVALID_PARAMS',
              `${f.path} is missing required fields: ${missing.join(', ')}`,
              'Fill in the frontmatter or run check interactively');
          }
          console.log(`Filling in missing frontmatter for ${f.path}:`);
          config = await promptConfig(config, missing);
          const finalConfig = mergeConfig({}, config);
          await writeFile(f.path, serializeFrontmatter(finalConfig, parsed.body || '# TODO\n'));
          desired.set(f.id, { config: finalConfig, body: parsed.body, filePath: f.path });
        } else {
          desired.set(f.id, { config: mergeConfig({}, config), body: parsed.body, filePath: f.path });
        }
      }

      console.log(`Check complete: ${desired.size} schedule(s) checked.`);

      const cfg = await loadConfig();
      const watched = cfg.daemon?.scheduler?.watchedFolders ?? [];
      if (!watched.find((w) => w.path === folder)) {
        console.log('\nThis folder is not watched. Run:');
        console.log(`  agentio schedule watch ${abbrHome(folder)}`);
      }
    } catch (e) {
      handleError(e);
    }
  };

  schedule.command('check').description('Validate .run.md files in a folder (id collisions, missing frontmatter, .gitignore scaffolding)')
    .option('--folder <path>', 'Folder to check (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(checkAction);

  schedule.command('sync', { hidden: true })
    .description('[deprecated] alias of `check`')
    .option('--folder <path>', 'Folder to check (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(async (opts: { folder?: string; yes?: boolean }) => {
      console.error('warning: `agentio schedule sync` is deprecated; use `schedule check`.');
      await checkAction(opts);
    });

  schedule.command('remove').description('Delete a schedule (.run.md file)')
    .argument('<id-or-file>', 'Schedule id, or path to a .run.md file')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        let matches: ReturnType<typeof walkRunFiles>;
        if (id.endsWith('.run.md')) {
          const filePath = isAbsolute(id) ? id : resolve(folder, id);
          if (!existsSync(filePath)) {
            throw new CliError('NOT_FOUND', `No file at ${filePath}`);
          }
          const idFromPath = basename(filePath).slice(0, -'.run.md'.length);
          matches = [{ path: filePath, id: idFromPath }];
        } else {
          matches = walkRunFiles(folder).filter((f) => f.id === id);
        }
        if (matches.length === 0) {
          throw new CliError('NOT_FOUND', `No .run.md file found for id "${id}" under ${folder}`,
            'Check the id (ls **/*.run.md) or run schedule list');
        }
        if (matches.length > 1) {
          throw new CliError('INVALID_PARAMS',
            `Multiple files match id "${id}": ${matches.map((m) => m.path).join(', ')}`);
        }
        await unlink(matches[0].path);
        console.log(`Removed schedule "${id}" (deleted ${matches[0].path})`);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('-q, --quiet', 'Suppress streaming child output to stdout/stderr (used when invoked by the daemon)')
    .action(async (id: string, opts: { folder?: string; quiet?: boolean }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const config = await loadConfig();
        const apiKey = config.daemon?.apiKey;
        const port = config.daemon?.server?.port ?? 7890;

        // Try daemon delegation
        if (apiKey) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/scheduler/run`, {
              method: 'POST',
              headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder, id }),
              signal: AbortSignal.timeout(2000),
            });
            if (res.ok) {
              const result = await res.json() as { started: boolean; reason?: string };
              if (result.started) {
                console.log(`Run queued via daemon. Tail logs in ${folder}/.agentio/runs/${id}/`);
                return;
              }
              console.error(`Daemon refused: ${result.reason}`);
              process.exit(1);
            }
          } catch { /* daemon not up — fall through */ }
        }

        // Local fallback
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length !== 1) {
          throw new CliError('NOT_FOUND', `No unique .run.md file for id "${id}" under ${folder}`);
        }
        const raw = await readFile(matches[0].path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const cfg = mergeConfig({}, parsed.config);
        const { exitCode, logPath } = await runSchedule({
          folder, id, promptBody: parsed.body, config: cfg, quiet: opts.quiet ?? false,
        });
        if (!opts.quiet) console.log(`Run complete. Log: ${logPath}`);
        process.exit(exitCode);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('show').description('Show a schedule and next run times')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length !== 1) {
          throw new CliError('NOT_FOUND', `No unique .run.md file for id "${id}" under ${folder}`);
        }
        const raw = await readFile(matches[0].path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const cfg = mergeConfig({}, parsed.config);
        console.log(`id:            ${id}`);
        console.log(`file:          ${matches[0].path}`);
        console.log(`schedule:      ${describeSchedule(cfg.schedule)}`);
        console.log(`model:         ${cfg.model}`);
        console.log(`permissionMode:${cfg.permissionMode}`);
        console.log(`sessionMode:   ${cfg.sessionMode}`);
        console.log(`enabled:       ${cfg.enabled}`);
        if (cfg.command) console.log(`command:       ${cfg.command}`);
        if (cfg.host) {
          const hostState = hostMatches(cfg) ? 'matches current host' : `pinned to "${cfg.host}"; current is "${getCurrentHost()}"`;
          console.log(`host:          ${cfg.host} (${hostState})`);
        }
        console.log('next 5 runs:');
        for (const d of nextRuns(cfg.schedule, 5)) {
          console.log(`  ${d.toISOString()}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  const historyAction = async (id: string, opts: { folder?: string }) => {
    try {
      const folder = opts.folder ? resolve(opts.folder) : process.cwd();
      const runs = listRuns(folder, id);
      if (runs.length === 0) { console.log(`No runs recorded for "${id}".`); return; }
      for (const r of runs) {
        const dur = r.durationMs !== undefined ? `${r.durationMs}ms` : '-';
        console.log(`${r.file}  status=${r.status ?? '?'}  exit=${r.exitCode ?? '?'}  duration=${dur}  session=${r.sessionId ?? '-'}`);
      }
    } catch (e) {
      handleError(e);
    }
  };

  schedule.command('history').description('List past runs for a schedule')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(historyAction);

  schedule.command('runs', { hidden: true })
    .description('[deprecated] alias of `history`')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      console.error('warning: `agentio schedule runs` is deprecated; use `schedule history`.');
      await historyAction(id, opts);
    });

  schedule.command('watch').description('Register a folder for the agentio daemon to scan')
    .argument('<folder>', 'Folder to watch (absolute or relative)')
    .option('--no-host-pin', 'Do not pin this folder to the current host')
    .action(async (folder: string, opts: { hostPin: boolean }) => {
      try {
        const absPath = resolve(folder);
        if (!existsSync(absPath)) {
          throw new CliError('NOT_FOUND', `Folder does not exist: ${absPath}`);
        }
        const config = await loadConfig();
        const host = opts.hostPin === false ? undefined : getCurrentHost();
        const updated = addWatchedFolder(config, absPath, host, Date.now());
        await saveConfig(updated);

        const apiKey = updated.daemon?.apiKey;
        const port = updated.daemon?.server?.port ?? 7890;

        console.log(`Watching ${abbrHome(absPath)}${host ? ` (pinned to ${host})` : ''}.`);

        // Ensure daemon is running (offer to install/start if not), then reload
        const { ensureDaemonRunning } = await import('../utils/daemon-ensure');
        const daemonAlive = await ensureDaemonRunning();
        if (daemonAlive) {
          try {
            await fetch(`http://127.0.0.1:${port}/scheduler/reload`, {
              method: 'POST',
              headers: { 'X-API-Key': apiKey ?? '' },
              signal: AbortSignal.timeout(1500),
            });
            console.log('Daemon reloaded — new schedules will fire immediately.');
          } catch {
            // Best-effort; ignore.
          }
        } else {
          console.log('Watched folder added; the daemon will pick it up when it starts.');
          console.log('Start it with: agentio daemon start');
        }
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('unwatch').description('Stop watching a folder')
    .argument('<folder>', 'Folder to remove')
    .action(async (folder: string) => {
      try {
        const absPath = resolve(folder);
        const config = await loadConfig();
        const updated = removeWatchedFolder(config, absPath);
        await saveConfig(updated);

        // Best-effort reload
        const apiKey = updated.daemon?.apiKey;
        const port = updated.daemon?.server?.port ?? 7890;
        if (apiKey) {
          try {
            await fetch(`http://127.0.0.1:${port}/scheduler/reload`, {
              method: 'POST',
              headers: { 'X-API-Key': apiKey },
              signal: AbortSignal.timeout(1500),
            });
          } catch { /* ignore */ }
        }

        console.log(`Unwatched ${abbrHome(absPath)}.`);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('watched', { hidden: true })
    .description('[deprecated] alias of `list --folders`')
    .action(async () => {
      console.error('warning: `agentio schedule watched` is deprecated; use `schedule list --folders`.');
      try {
        const config = await loadConfig();
        const folders = config.daemon?.scheduler?.watchedFolders ?? [];
        printWatchedFolders(folders);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('migrate', { hidden: true }).description('Remove legacy per-schedule launchd plists and add their folders to the daemon watch list')
    .action(async () => {
      try {
        if (process.platform !== 'darwin') {
          console.log('`schedule migrate` only applies on macOS.');
          return;
        }
        const dir = join(homedir(), 'Library', 'LaunchAgents');
        if (!existsSync(dir)) {
          console.log('Nothing to migrate.');
          return;
        }
        const entries = readdirSync(dir)
          .filter((f) => f.startsWith('me.agentio.schedule.') && f.endsWith('.plist'));
        if (entries.length === 0) {
          console.log('Nothing to migrate.');
          return;
        }
        const folders = new Set<string>();
        for (const file of entries) {
          const full = join(dir, file);
          try {
            const raw = readFileSync(full, 'utf-8');
            const parsed = plist.parse(raw) as Record<string, unknown>;
            const args = parsed.ProgramArguments as string[] | undefined;
            if (args) {
              const fi = args.indexOf('--folder');
              if (fi !== -1 && args[fi + 1]) folders.add(args[fi + 1]);
            }
            execFileSync('/bin/launchctl', ['unload', full], { stdio: 'ignore' });
            unlinkSync(full);
          } catch { /* continue */ }
        }

        let config = await loadConfig();
        const host = getCurrentHost();
        for (const f of folders) {
          config = addWatchedFolder(config, f, host, Date.now());
        }
        await saveConfig(config);

        console.log(`Migrated ${entries.length} schedule(s) across ${folders.size} folder(s).`);
        console.log('Folders added to watch list:');
        for (const f of folders) console.log(`  ${abbrHome(f)}`);
        console.log('\nIf the daemon is not installed yet, run: agentio daemon install');
      } catch (e) {
        handleError(e);
      }
    });
}
