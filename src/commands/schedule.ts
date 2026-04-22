import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
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
import { parseWeekdays, weekdayNames } from '../services/schedule/weekdays';
import { installPlist, enumerateInstalledSchedules, uninstallPlist } from '../services/schedule/launchd';
import { walkRunFiles } from '../services/schedule/walker';
import { runSchedule } from '../services/schedule/runner';
import { folderHash } from '../services/schedule/folder-hash';
import { buildPlistDict } from '../services/schedule/plist-builder';
import { nextRuns } from '../services/schedule/schedule-calculator';
import { listRuns } from '../services/schedule/runs';
import { getCurrentHost, hostMatches } from '../services/schedule/host';
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

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'manual': return 'Manual';
    case 'daily':
      return `Daily at ${fmtHM(s.hour, s.minute)}`;
    case 'weekly':
      return `Weekly ${weekdayNames(s.weekdays ?? [])} at ${fmtHM(s.hour, s.minute)}`;
    case 'monthly':
      return `Monthly on day ${s.day} at ${fmtHM(s.hour, s.minute)}`;
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

const WEEKDAY_SHORT = ['', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function formatWeekdaysShort(nums: number[]): string {
  return nums.map((n) => WEEKDAY_SHORT[n] ?? String(n)).join(',');
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
    .option('--host <name>', 'Pin schedule to a specific hostname; skipped on other machines')
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
          merged = await promptConfig(merged, missing);
        }

        const finalConfig: FrontmatterConfig = mergeConfig({}, merged);

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, serializeFrontmatter(finalConfig, existingBody));

        const id = file.split('/').pop()!.slice(0, -'.run.md'.length);
        if (hostMatches(finalConfig)) {
          installPlist(folder, id, finalConfig);
          console.log(`Installed schedule "${id}" in ${folder}`);
        } else {
          // Schedule pinned to another host — make sure a stale plist from a
          // prior host match isn't left behind, then skip install.
          uninstallPlist(folder, id);
          console.log(`Wrote "${id}" (pinned to host "${finalConfig.host}"; current host is "${getCurrentHost()}"; plist not installed)`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('list').description('List installed schedules')
    .option('--folder <path>', 'Filter to one folder')
    .action(async (opts: { folder?: string }) => {
      try {
        const filterFolder = opts.folder ? resolve(opts.folder) : undefined;
        const installed = enumerateInstalledSchedules();
        const rows = installed
          .filter((p) => !filterFolder || p.folder === filterFolder)
          .map((p) => {
            const glob = walkRunFiles(p.folder).find((f) => f.id === p.id);
            if (!glob) {
              return {
                folder: p.folder, id: p.id, schedule: '[broken: .run.md missing]',
                model: '-', next: '-', enabled: '-',
              };
            }
            try {
              const raw = readFileSync(glob.path, 'utf-8');
              const parsed = parseFrontmatter(raw);
              const cfg = mergeConfig({}, parsed.config);
              const next = nextRuns(cfg.schedule, 1)[0];
              return {
                folder: p.folder, id: p.id, schedule: describeSchedule(cfg.schedule),
                model: cfg.command ? `cmd: ${cfg.command}` : cfg.model,
                next: next ? next.toISOString() : '-',
                enabled: cfg.enabled ? 'yes' : 'no',
              };
            } catch {
              return { folder: p.folder, id: p.id, schedule: '[parse error]', model: '-', next: '-', enabled: '-' };
            }
          });
        if (rows.length === 0) { console.log('No schedules installed.'); return; }
        for (const r of rows) {
          console.log(`${r.folder}  ${r.id}  ${r.schedule}  (${r.model})  next: ${r.next}  enabled: ${r.enabled}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('sync').description('Reconcile launchd plists with *.run.md files')
    .option('--folder <path>', 'Folder to sync (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(async (opts: { folder?: string; yes?: boolean }) => {
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
          if (missing.length > 0) {
            if (opts.yes || !isInteractive()) {
              throw new CliError('INVALID_PARAMS',
                `${f.path} is missing required fields: ${missing.join(', ')}`,
                'Fill in the frontmatter or run sync interactively');
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

        // 5. Diff against installed plists
        const installed = enumerateInstalledSchedules();
        const targetHash = folderHash(folder);
        const installedForFolder = installed.filter((p) => p.folder === folder || p.label.startsWith(`me.agentio.schedule.${targetHash}-`));

        const installedIds = new Set(installedForFolder.map((p) => p.id));
        const currentHost = getCurrentHost();

        // Partition desired into those for this host vs. pinned elsewhere.
        const desiredForThisHost = new Map<string, { config: FrontmatterConfig; body: string; filePath: string }>();
        const desiredForOtherHost = new Map<string, { config: FrontmatterConfig; body: string; filePath: string }>();
        for (const [id, entry] of desired) {
          if (hostMatches(entry.config, currentHost)) desiredForThisHost.set(id, entry);
          else desiredForOtherHost.set(id, entry);
        }

        // 5a. Orphans: installed plist with no matching .run.md file -> uninstall
        const allDesiredIds = new Set(desired.keys());
        for (const p of installedForFolder) {
          if (!allDesiredIds.has(p.id)) {
            uninstallPlist(folder, p.id);
            console.log(`Removed orphan plist: ${p.id}`);
          }
        }

        // 5b. Host-pinned-elsewhere but currently installed -> uninstall
        for (const [id, { config }] of desiredForOtherHost) {
          if (installedIds.has(id)) {
            uninstallPlist(folder, id);
            console.log(`Uninstalled "${id}" (pinned to host "${config.host}", this host is "${currentHost}")`);
          }
        }

        // 5c. New or changed for this host: install/update
        for (const [id, { config }] of desiredForThisHost) {
          const dict = buildPlistDict(folder, id, config);
          let needsInstall = !installedIds.has(id);
          if (!needsInstall) {
            const existing = installedForFolder.find((p) => p.id === id)!;
            try {
              const raw = await readFile(existing.plistPath, 'utf-8');
              const parsedDict = (await import('plist')).default.parse(raw) as Record<string, unknown>;
              if (JSON.stringify(parsedDict) !== JSON.stringify(dict)) needsInstall = true;
            } catch { needsInstall = true; }
          }
          if (needsInstall) {
            installPlist(folder, id, config);
            console.log(`Installed/updated: ${id}`);
          }
        }

        const skipped = desiredForOtherHost.size;
        const skipNote = skipped > 0 ? ` (${skipped} pinned to other hosts)` : '';
        console.log(`Sync complete: ${desiredForThisHost.size} on this host${skipNote}.`);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('remove').description('Delete a schedule and uninstall its plist')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length === 0) {
          // still attempt plist uninstall in case the file was already removed
          uninstallPlist(folder, id);
          throw new CliError('NOT_FOUND', `No .run.md file found for id "${id}" under ${folder}`,
            'Check the id (ls **/*.run.md) or run schedule list');
        }
        if (matches.length > 1) {
          throw new CliError('INVALID_PARAMS',
            `Multiple files match id "${id}": ${matches.map((m) => m.path).join(', ')}`);
        }
        await unlink(matches[0].path);
        uninstallPlist(folder, id);
        console.log(`Removed schedule "${id}" (deleted ${matches[0].path}, uninstalled plist)`);
      } catch (e) {
        handleError(e);
      }
    });

  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('--from-launchd', 'Internal: flag set by launchd-triggered invocations')
    .action(async (id: string, opts: { folder?: string; fromLaunchd?: boolean }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length !== 1) {
          throw new CliError('NOT_FOUND', `No unique .run.md file for id "${id}" under ${folder}`,
            'Run `agentio schedule list` to see available ids');
        }
        const raw = await readFile(matches[0].path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const cfg = mergeConfig({}, parsed.config);
        const { exitCode, logPath } = await runSchedule({
          folder, id, promptBody: parsed.body, config: cfg,
        });
        if (!opts.fromLaunchd) {
          console.log(`Run complete. Log: ${logPath}`);
        }
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

  schedule.command('runs').description('List past runs for a schedule')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
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
    });
}
