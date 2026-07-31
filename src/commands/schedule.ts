import { Command } from 'commander';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { CliError, handleError } from '../utils/errors';
import {
  mergeConfig,
  parseFrontmatter,
} from '../services/schedule/frontmatter';
import { describeSchedule } from '../services/schedule/describe';
import { walkRunFiles, type RunFile } from '../services/schedule/walker';
import { runSchedule } from '../services/schedule/runner';
import { checkClaude, CLAUDE_SEARCH_PATHS } from '../services/schedule/doctor';
import type { Model } from '../types/schedule';
import { nextRuns } from '../services/schedule/schedule-calculator';
import { listRuns, type RunEntry } from '../services/schedule/runs';
import { getCurrentHost, hostMatches } from '../services/schedule/host';
import { scanWatchedFolders } from '../daemon/scheduler-core';
import type { SchedulerJobView } from '../daemon/scheduler';
import { loadConfig, saveConfig } from '../config/config-manager';
import { addWatchedFolder, removeWatchedFolder } from './schedule-watch';
import { abbrHome } from '../utils/output';
import { addExamples } from '../utils/command-tree';
import type { Config, WatchedFolder } from '../types/config';

function getDaemonEndpoint(config: Config): { apiKey?: string; port: number } {
  return {
    apiKey: config.daemon?.apiKey,
    port: config.daemon?.server?.port ?? 7890,
  };
}

function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function relativeFromNow(d: Date, now: Date = new Date()): string {
  const diffMs = d.getTime() - now.getTime();
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const s = Math.floor(abs / 1000);
  if (s < 60) return past ? `${s}s ago` : `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return past ? `${h}h ago` : `in ${h}h`;
  const days = Math.floor(h / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function parseLogFilename(file: string): Date | null {
  const m = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z\.log$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function watchedFolders(config: Config): WatchedFolder[] {
  return config.daemon?.scheduler?.watchedFolders ?? [];
}

function safeWalk(folder: string): RunFile[] {
  try { return walkRunFiles(folder); } catch { return []; }
}

interface ResolvedJob { folder: string; file: RunFile; }

/**
 * Resolve a job id to its watched folder + matched file. CWD plays no role.
 * - explicit `--folder` wins (must contain a matching .run.md).
 * - else: scan all watched folders. 0 → error; 1 → use it; >1 → require --folder.
 */
function resolveJob(config: Config, id: string, explicitFolder?: string): ResolvedJob {
  if (explicitFolder) {
    const folder = resolve(explicitFolder);
    const file = safeWalk(folder).find((f) => f.id === id);
    if (!file) throw new CliError('NOT_FOUND', `No .run.md file with id "${id}" under ${folder}`);
    return { folder, file };
  }
  const folders = watchedFolders(config);
  if (folders.length === 0) {
    throw new CliError(
      'NOT_FOUND',
      'No watched folders configured.',
      'Add one with: agentio schedule add <folder>',
    );
  }
  const matches: ResolvedJob[] = [];
  for (const f of folders) {
    const file = safeWalk(f.path).find((rf) => rf.id === id);
    if (file) matches.push({ folder: f.path, file });
  }
  if (matches.length === 0) {
    const list = folders.map((f) => `  ${abbrHome(f.path)}`).join('\n');
    throw new CliError(
      'NOT_FOUND',
      `No .run.md file with id "${id}" in any watched folder.\n\nWatched folders:\n${list}`,
    );
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `  ${abbrHome(m.folder)}`).join('\n');
    throw new CliError(
      'INVALID_PARAMS',
      `Multiple watched folders contain "${id}.run.md":\n${candidates}`,
      'Use --folder <path> to disambiguate',
    );
  }
  return matches[0];
}

function renderJobs(jobs: SchedulerJobView[], filterFolder?: string): void {
  const filtered = filterFolder
    ? jobs.filter((j) => j.folder === resolve(filterFolder))
    : jobs;
  if (filtered.length === 0) {
    console.log('No schedules.');
    console.log('Add one with: agentio schedule add <folder>');
    return;
  }
  const now = new Date();
  const rows = filtered.map((r) => {
    const d = new Date(r.nextRun);
    const next = isNaN(d.getTime()) ? r.nextRun : `${formatLocal(d)} (${relativeFromNow(d, now)})`;
    return { ...r, nextDisplay: next };
  });
  const widths = {
    id: Math.max('ID'.length, ...rows.map((r) => r.id.length)),
    folder: Math.max('FOLDER'.length, ...rows.map((r) => abbrHome(r.folder).length)),
    sched: Math.max('SCHEDULE'.length, ...rows.map((r) => r.schedule.length)),
  };
  console.log(`${'ID'.padEnd(widths.id)}  ${'FOLDER'.padEnd(widths.folder)}  ${'SCHEDULE'.padEnd(widths.sched)}  NEXT`);
  for (const r of rows) {
    const tags: string[] = [];
    if (r.isRunning) tags.push('running');
    if (r.offHost && r.hostPin) tags.push(`pinned to ${r.hostPin}`);
    const suffix = tags.length ? `  [${tags.join(', ')}]` : '';
    console.log(`${r.id.padEnd(widths.id)}  ${abbrHome(r.folder).padEnd(widths.folder)}  ${r.schedule.padEnd(widths.sched)}  ${r.nextDisplay}${suffix}`);
  }
}

async function fetchSchedulerList(
  config: Config,
  allHosts: boolean,
): Promise<SchedulerJobView[] | null> {
  const { apiKey, port } = getDaemonEndpoint(config);
  if (!apiKey) return null;
  try {
    const url = `http://127.0.0.1:${port}/scheduler/list${allHosts ? '?all=1' : ''}`;
    const res = await fetch(url, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const { jobs } = await res.json() as { jobs: SchedulerJobView[] };
    return jobs;
  } catch {
    return null;
  }
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Watch folders for .run.md files (executed by the agentio daemon)');

  const addCmd = schedule.command('add')
    .description('Watch a folder for .run.md files')
    .argument('<folder>', 'Folder to watch')
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

        const { apiKey, port } = getDaemonEndpoint(updated);

        console.log(`Watching ${abbrHome(absPath)}${host ? ` (pinned to ${host})` : ''}.`);

        if (apiKey) {
          const { ensureDaemonRunning } = await import('../utils/daemon-ensure');
          const daemonAlive = await ensureDaemonRunning();
          if (daemonAlive) {
            try {
              await fetch(`http://127.0.0.1:${port}/scheduler/reload`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey },
                signal: AbortSignal.timeout(1500),
              });
              console.log('Daemon reloaded — new schedules will fire immediately.');
            } catch { /* ignore */ }
          } else {
            console.log('Watched folder added; the daemon will pick it up when it starts.');
            console.log('Start it with: agentio daemon start');
          }
        } else {
          console.log('Watched folder added; the daemon will pick it up when it starts.');
          console.log('Install it with: agentio daemon install');
        }
      } catch (e) {
        handleError(e);
      }
    });

  addExamples(
    addCmd,
    `Examples:

  # watch a folder of .run.md files (pinned to this hostname by default)
  agentio schedule add ~/Dropbox/schedules

  # watch but allow any host to fire (for non-Dropbox-synced folders)
  agentio schedule add ./agents --no-host-pin

After adding, author .run.md files in the folder directly. The daemon picks
them up via fs.watch within ~500ms. Run 'agentio schedule list' to confirm.`,
  );

  const printWatchedFolders = (folders: WatchedFolder[]): void => {
    if (folders.length === 0) {
      console.log('No folders watched.');
      console.log('Add one with: agentio schedule add <folder>');
      return;
    }
    console.log('Watched folders:');
    for (const f of folders) {
      const pin = f.host ? ` (pinned to ${f.host})` : '';
      console.log(`  ${abbrHome(f.path)}${pin}`);
    }
  };

  const listCmd = schedule.command('list').description('List watched folders and scheduled tasks')
    .option('--folder <path>', 'Filter schedules to one folder')
    .option('--folders', 'Show watched folders only (no schedules)')
    .option('--all-hosts', 'Include schedules pinned to other hosts')
    .action(async (opts: { folder?: string; folders?: boolean; allHosts?: boolean }) => {
      try {
        const config = await loadConfig();
        const folders = watchedFolders(config);

        printWatchedFolders(folders);

        if (opts.folders || folders.length === 0) return;

        console.log('');
        console.log('Schedules:');

        const fromDaemon = await fetchSchedulerList(config, !!opts.allHosts);
        if (fromDaemon) {
          renderJobs(fromDaemon, opts.folder);
          return;
        }

        const now = new Date();
        const host = getCurrentHost();
        const { jobs, skipped } = scanWatchedFolders(folders, host, now, { allHosts: !!opts.allHosts });
        const rows: SchedulerJobView[] = jobs.map((j) => ({
          folder: j.folder,
          id: j.id,
          schedule: describeSchedule(j.config.schedule),
          enabled: j.config.enabled,
          nextRun: j.nextRun.toISOString(),
          isRunning: false,
          ...(j.config.host ? { hostPin: j.config.host } : {}),
          ...(j.offHost ? { offHost: true } : {}),
        }));
        renderJobs(rows, opts.folder);
        if (skipped.length > 0) {
          console.log('');
          console.log(`Skipped ${skipped.length} file(s):`);
          for (const s of skipped) console.log(`  ${abbrHome(s.path)} — ${s.reason}`);
        }
        console.log('\n(daemon not running — showing filesystem view)');
      } catch (e) {
        handleError(e);
      }
    });

  addExamples(
    listCmd,
    `Examples:

  # watched folders + their detected schedules (host-pinned only)
  agentio schedule list

  # also show schedules pinned to other machines (Dropbox-shared folders)
  agentio schedule list --all-hosts

  # only schedules in one specific folder
  agentio schedule list --folder ~/Dropbox/schedules

  # just the watched-folder list, no schedule scan
  agentio schedule list --folders`,
  );

  const showCmd = schedule.command('show').description('Show a schedule and next run times')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Restrict resolution to this folder')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const config = await loadConfig();
        const { file } = resolveJob(config, id, opts.folder);
        const raw = await readFile(file.path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const cfg = mergeConfig({}, parsed.config);
        console.log(`id:            ${id}`);
        console.log(`file:          ${file.path}`);
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
        const showNow = new Date();
        for (const d of nextRuns(cfg.schedule, 5)) {
          console.log(`  ${formatLocal(d)} (${relativeFromNow(d, showNow)})`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  addExamples(
    showCmd,
    `Examples:

  # frontmatter + next 5 fire times for one schedule (id is the .run.md basename)
  agentio schedule show weekly-report

  # disambiguate when the same id exists in multiple watched folders
  agentio schedule show weekly-report --folder ~/Dropbox/schedules`,
  );

  const runCmd = schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Restrict resolution to this folder')
    .option('-q, --quiet', 'Suppress streaming child output to stdout/stderr (used when invoked by the daemon)')
    .action(async (id: string, opts: { folder?: string; quiet?: boolean }) => {
      try {
        const config = await loadConfig();
        const { folder, file } = resolveJob(config, id, opts.folder);
        const { apiKey, port } = getDaemonEndpoint(config);

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
                console.log(`Run queued via daemon. Tail logs in ${abbrHome(folder)}/.agentio/runs/${id}/`);
                return;
              }
              console.error(`Daemon refused: ${result.reason}`);
              process.exit(1);
            }
          } catch { /* daemon not up — fall through */ }
        }

        const raw = await readFile(file.path, 'utf-8');
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

  addExamples(
    runCmd,
    `Examples:

  # fire a schedule now (delegates to the daemon if running, else runs in-process)
  agentio schedule run weekly-report

  # restrict id resolution to one watched folder
  agentio schedule run weekly-report --folder ~/Dropbox/schedules

Manual runs ignore the host pin — useful for testing on a machine that isn't
the schedule's normal home.`,
  );

  const VALID_MODELS: Model[] = ['opus', 'sonnet', 'haiku'];

  const doctorCmd = schedule.command('doctor')
    .description('Check that the claude CLI is installed and logged in (runs a trivial prompt)')
    .option('--model <model>', 'Model for the smoke test (opus|sonnet|haiku)', 'haiku')
    .option('--timeout <seconds>', 'Seconds to wait for the test prompt', '60')
    .action(async (opts: { model: string; timeout: string }) => {
      try {
        if (!VALID_MODELS.includes(opts.model as Model)) {
          throw new CliError('INVALID_PARAMS', `Unknown model: ${opts.model}`, `Use one of: ${VALID_MODELS.join(', ')}`);
        }
        const timeoutSec = Number(opts.timeout);
        if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
          throw new CliError('INVALID_PARAMS', `Invalid --timeout: ${opts.timeout}`, 'Pass a positive number of seconds.');
        }

        console.error('Locating claude CLI...');
        const result = await checkClaude({ model: opts.model as Model, timeoutMs: timeoutSec * 1000 });

        if (!result.claudePath) {
          throw new CliError(
            'NOT_FOUND',
            'claude CLI not found.',
            `Install Claude Code, then re-run. Searched: ${CLAUDE_SEARCH_PATHS.join(', ')}.`,
          );
        }
        console.log(`claude binary:  ${result.claudePath}`);
        console.log(`model:          ${result.model}`);
        console.log(`exit code:      ${result.exitCode}`);
        console.log(`duration:       ${formatDuration(result.durationMs)}`);
        if (result.stdout) console.log(`output:         ${result.stdout.split('\n')[0].slice(0, 200)}`);

        if (result.timedOut) {
          throw new CliError(
            'API_ERROR',
            `claude did not respond within ${timeoutSec}s (killed).`,
            'A hung login prompt is the usual cause — run `claude` once interactively to log in, or raise --timeout.',
          );
        }
        if (!result.ok) {
          const detail = result.stderr ? `\n${result.stderr.split('\n').slice(0, 5).join('\n')}` : '';
          throw new CliError(
            'AUTH_FAILED',
            `claude exited with code ${result.exitCode}.${detail}`,
            'Run `claude` once interactively to complete login, then re-run `agentio schedule doctor`.',
          );
        }

        console.log('\n✓ claude is installed and logged in — scheduled runs can spawn it.');
      } catch (e) {
        handleError(e);
      }
    });

  addExamples(
    doctorCmd,
    `Examples:

  # verify the daemon will be able to run claude
  agentio schedule doctor

  # test with a specific model and a longer timeout
  agentio schedule doctor --model sonnet --timeout 90

This runs a trivial prompt through the same login-shell environment the daemon
uses, so a green result means scheduled .run.md jobs can launch claude.`,
  );

  interface AggregatedRun {
    id: string;
    folder: string;
    last: RunEntry;
  }

  /** Collect last runs across all watched folders, sorted most-recent first. */
  function collectAllLastRuns(folders: WatchedFolder[]): AggregatedRun[] {
    const out: AggregatedRun[] = [];
    for (const f of folders) {
      for (const file of safeWalk(f.path)) {
        const runs = listRuns(f.path, file.id);
        if (runs.length === 0) continue;
        out.push({ id: file.id, folder: f.path, last: runs[0] });
      }
    }
    out.sort((a, b) => {
      const at = entryStart(a.last)?.getTime() ?? 0;
      const bt = entryStart(b.last)?.getTime() ?? 0;
      return bt - at;
    });
    return out;
  }

  function entryStart(r: RunEntry): Date | null {
    if (r.startedAt) {
      const d = new Date(r.startedAt);
      if (!isNaN(d.getTime())) return d;
    }
    return parseLogFilename(r.file);
  }

  function renderRunRow(when: string, status: string | undefined, exitCode: number | undefined, durationMs: number | undefined, session: string | undefined): string {
    return `${when}  status=${status ?? '?'}  exit=${exitCode ?? '?'}  duration=${formatDuration(durationMs)}  session=${session ?? '-'}`;
  }

  const historyCmd = schedule.command('history').description('List past runs (no id: last run of every job; with id: all runs of that job)')
    .argument('[id]', 'Schedule id (optional)')
    .option('--folder <path>', 'Restrict to one folder')
    .action(async (id: string | undefined, opts: { folder?: string }) => {
      try {
        const config = await loadConfig();
        const now = new Date();

        if (!id) {
          // List last run of every job across watched folders.
          const folders = opts.folder
            ? [{ path: resolve(opts.folder), addedAt: 0 } as WatchedFolder]
            : watchedFolders(config);
          if (folders.length === 0) {
            console.log('No watched folders configured.');
            console.log('Add one with: agentio schedule add <folder>');
            return;
          }
          const rows = collectAllLastRuns(folders);
          if (rows.length === 0) {
            console.log('No runs recorded yet.');
            return;
          }
          const widths = {
            id: Math.max('JOB-ID'.length, ...rows.map((r) => r.id.length)),
            folder: Math.max('FOLDER'.length, ...rows.map((r) => abbrHome(r.folder).length)),
          };
          console.log(`${'JOB-ID'.padEnd(widths.id)}  ${'FOLDER'.padEnd(widths.folder)}  LAST RUN`);
          for (const r of rows) {
            const start = entryStart(r.last);
            const when = start
              ? `${formatLocal(start)} (${relativeFromNow(start, now)})`
              : r.last.file;
            const tail = `  status=${r.last.status ?? '?'}  exit=${r.last.exitCode ?? '?'}  duration=${formatDuration(r.last.durationMs)}`;
            console.log(`${r.id.padEnd(widths.id)}  ${abbrHome(r.folder).padEnd(widths.folder)}  ${when}${tail}`);
          }
          return;
        }

        // Single-job mode.
        const { folder } = resolveJob(config, id, opts.folder);
        const runs = listRuns(folder, id);
        if (runs.length === 0) {
          console.log(`No runs recorded for "${id}" in ${abbrHome(folder)}.`);
          return;
        }
        for (const r of runs) {
          const start = entryStart(r);
          const when = start
            ? `${formatLocal(start)} (${relativeFromNow(start, now)})`
            : r.file;
          console.log(renderRunRow(when, r.status, r.exitCode, r.durationMs, r.sessionId));
        }
      } catch (e) {
        handleError(e);
      }
    });

  addExamples(
    historyCmd,
    `Examples:

  # overview: last run of every job across all watched folders
  agentio schedule history

  # full run history for one schedule (newest first)
  agentio schedule history weekly-report

  # restrict the overview to one folder
  agentio schedule history --folder ~/Dropbox/schedules

Per-run logs land in <folder>/.agentio/runs/<id>/<ISO>.log.`,
  );

  const removeCmd = schedule.command('remove')
    .description('Stop watching a folder')
    .argument('<folder>', 'Folder to remove')
    .action(async (folder: string) => {
      try {
        const absPath = resolve(folder);
        const config = await loadConfig();
        const before = watchedFolders(config);
        const wasWatched = before.some((f) => f.path === absPath);

        if (!wasWatched) {
          console.log(`Not watching ${abbrHome(absPath)}.`);
          return;
        }

        const updated = removeWatchedFolder(config, absPath);
        await saveConfig(updated);

        const { apiKey, port } = getDaemonEndpoint(updated);
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

  addExamples(
    removeCmd,
    `Examples:

  # stop watching a folder (existing .run.md files are not deleted)
  agentio schedule remove ~/Dropbox/schedules`,
  );
}
