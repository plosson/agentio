import { Command } from 'commander';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import plist from 'plist';
import { CliError, handleError } from '../utils/errors';
import {
  mergeConfig,
  parseFrontmatter,
} from '../services/schedule/frontmatter';
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
import { abbrHome } from '../utils/output';
import type { Config } from '../types/config';

function getDaemonEndpoint(config: Config): { apiKey?: string; port: number } {
  return {
    apiKey: config.daemon?.apiKey,
    port: config.daemon?.server?.port ?? 7890,
  };
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
    console.log('Add one with: agentio schedule add <folder>');
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
    .description('Watch folders for .run.md files (executed by the agentio daemon)');

  schedule.command('add')
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

  const printWatchedFolders = (folders: { path: string; host?: string }[]): void => {
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

  schedule.command('list').description('List watched folders and scheduled tasks')
    .option('--folder <path>', 'Filter schedules to one folder')
    .option('--folders', 'Show watched folders only (no schedules)')
    .action(async (opts: { folder?: string; folders?: boolean }) => {
      try {
        const config = await loadConfig();
        const folders = config.daemon?.scheduler?.watchedFolders ?? [];

        printWatchedFolders(folders);

        if (opts.folders || folders.length === 0) return;

        const { apiKey, port } = getDaemonEndpoint(config);

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

  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('-q, --quiet', 'Suppress streaming child output to stdout/stderr (used when invoked by the daemon)')
    .action(async (id: string, opts: { folder?: string; quiet?: boolean }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const config = await loadConfig();
        const { apiKey, port } = getDaemonEndpoint(config);

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

  schedule.command('remove')
    .description('Stop watching a folder')
    .argument('<folder>', 'Folder to remove')
    .action(async (folder: string) => {
      try {
        const absPath = resolve(folder);
        const config = await loadConfig();
        const before = config.daemon?.scheduler?.watchedFolders ?? [];
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
