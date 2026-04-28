import type { WatchedFolder } from '../types/config';
import { readFile } from 'fs/promises';
import { existsSync, watch as fsWatch, type FSWatcher } from 'fs';
import { join } from 'path';
import { scanWatchedFolders, type ScheduledJob } from './scheduler-core';
import { runSchedule, type Spawner } from '../services/schedule/runner';
import { readState } from '../services/schedule/state';
import { parseFrontmatter, mergeConfig } from '../services/schedule/frontmatter';
import { getCurrentHost } from '../services/schedule/host';
import { prevRun } from '../services/schedule/schedule-calculator';

export interface StartSchedulerOpts {
  watchedFolders: WatchedFolder[];
  currentHost?: string;
  tickIntervalMs?: number;
  /** injected for tests; defaults to child_process.spawn */
  spawner?: Spawner;
  /** injected for tests; defaults to locateClaude() */
  claudePath?: string | null;
  /** injected for tests */
  now?: () => Date;
  /** Disable filesystem watcher (useful in tests). */
  disableFsWatch?: boolean;
}

let tickInterval: ReturnType<typeof setInterval> | null = null;
const inFlight: Set<string> = new Set();
let currentOpts: StartSchedulerOpts | null = null;
const fsWatchers: FSWatcher[] = [];
let watchDebounce: ReturnType<typeof setTimeout> | null = null;
const warnedSkips: Set<string> = new Set();

function jobKey(j: ScheduledJob): string {
  return `${j.folder}::${j.id}`;
}

async function fireJob(job: ScheduledJob, opts: StartSchedulerOpts): Promise<void> {
  const key = jobKey(job);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const raw = await readFile(job.filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    await runSchedule({
      folder: job.folder,
      id: job.id,
      promptBody: parsed.body,
      config: job.config,
      quiet: true,
      spawner: opts.spawner,
      claudePath: opts.claudePath,
      now: opts.now,
    });
  } catch (e) {
    console.error(`[scheduler] fire failed for ${job.folder}::${job.id}:`,
      e instanceof Error ? e.message : e);
  } finally {
    inFlight.delete(key);
  }
}

async function tick(opts: StartSchedulerOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))();
  const host = opts.currentHost ?? getCurrentHost();
  const { jobs, skipped } = scanWatchedFolders(opts.watchedFolders, host, now);
  for (const s of skipped) {
    const key = `${s.path}::${s.reason}`;
    if (warnedSkips.has(key)) continue;
    warnedSkips.add(key);
    console.warn(`[scheduler] skipping ${s.path}: ${s.reason}`);
  }

  for (const j of jobs) {
    const key = jobKey(j);
    if (inFlight.has(key)) {
      console.log(`[scheduler] skipped ${j.folder}::${j.id} (still running)`);
      continue;
    }
    const prev = prevRun(j.config.schedule, now);
    if (!prev) continue;
    const state = await readState(j.folder).catch(() => ({} as Record<string, { lastRunAt?: string }>));
    const lastRunAtIso = state[j.id]?.lastRunAt;
    const shouldFire = !lastRunAtIso || new Date(lastRunAtIso).getTime() < prev.getTime();
    if (shouldFire) {
      fireJob(j, opts).catch((e) => console.error('[scheduler]', e));
    }
  }
}

function closeWatchers(): void {
  for (const w of fsWatchers) {
    w.removeAllListeners();
    try { w.close(); } catch { /* ignore */ }
  }
  fsWatchers.length = 0;
}

function startWatchers(folders: WatchedFolder[]): void {
  closeWatchers();
  warnedSkips.clear();  // refresh warnings since the folder set changed
  for (const f of folders) {
    try {
      const w = fsWatch(f.path, { recursive: true }, (_event, filename) => {
        if (!filename || typeof filename !== 'string') return;
        if (!filename.endsWith('.run.md')) return;
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          watchDebounce = null;
          if (currentOpts) tick(currentOpts).catch((e) => console.error('[scheduler]', e));
        }, 500);
      });
      w.on('error', (e) => console.warn(`[scheduler] watcher error on ${f.path}:`, e.message));
      fsWatchers.push(w);
    } catch (e) {
      console.warn(`[scheduler] could not watch ${f.path}:`, (e as Error).message);
    }
  }
}

export async function startScheduler(opts: StartSchedulerOpts): Promise<void> {
  if (tickInterval) throw new Error('scheduler already started');
  currentOpts = opts;
  const intervalMs = opts.tickIntervalMs ?? 60_000;
  await tick(opts);
  tickInterval = setInterval(() => { tick(opts).catch(console.error); }, intervalMs);
  if (!opts.disableFsWatch) startWatchers(opts.watchedFolders);
}

export async function reloadScheduler(watchedFolders: WatchedFolder[]): Promise<void> {
  if (!currentOpts) return;
  currentOpts = { ...currentOpts, watchedFolders };
  if (!currentOpts.disableFsWatch) startWatchers(watchedFolders);
  await tick(currentOpts);
}

export interface StopSchedulerOpts {
  waitMs?: number;
}

export interface SchedulerJobView {
  folder: string;
  id: string;
  schedule: string;
  enabled: boolean;
  nextRun: string;
  lastRunAt?: string;
  lastExitCode?: number;
  isRunning: boolean;
  hostPin?: string;
  offHost?: boolean;
}

export async function listSchedulerJobs(opts: { allHosts?: boolean } = {}): Promise<SchedulerJobView[]> {
  if (!currentOpts) return [];
  const host = currentOpts.currentHost ?? getCurrentHost();
  const now = (currentOpts.now ?? (() => new Date()))();
  const { describeSchedule } = await import('../services/schedule/describe');
  const { jobs } = scanWatchedFolders(currentOpts.watchedFolders, host, now, { allHosts: opts.allHosts });
  const out: SchedulerJobView[] = [];
  for (const j of jobs) {
    const state = await readState(j.folder).catch(() => ({} as Record<string, { lastRunAt?: string; lastExitCode?: number }>));
    out.push({
      folder: j.folder,
      id: j.id,
      schedule: describeSchedule(j.config.schedule),
      enabled: j.config.enabled,
      nextRun: j.nextRun.toISOString(),
      lastRunAt: state[j.id]?.lastRunAt,
      lastExitCode: state[j.id]?.lastExitCode,
      isRunning: inFlight.has(jobKey(j)),
      ...(j.config.host ? { hostPin: j.config.host } : {}),
      ...(j.offHost ? { offHost: true } : {}),
    });
  }
  return out;
}

export async function runOneJob(folder: string, id: string): Promise<{
  started: boolean;
  reason?: string;
}> {
  if (!currentOpts) return { started: false, reason: 'scheduler not running' };

  const watched = currentOpts.watchedFolders.some((f) => f.path === folder);
  if (!watched) return { started: false, reason: 'folder not watched' };

  const filePath = join(folder, `${id}.run.md`);
  if (!existsSync(filePath)) return { started: false, reason: 'no .run.md found for this id' };

  const raw = await readFile(filePath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  const cfg = mergeConfig({}, parsed.config);

  const job: ScheduledJob = {
    folder,
    id,
    filePath,
    config: cfg,
    nextRun: new Date(),
  };
  if (inFlight.has(jobKey(job))) return { started: false, reason: 'already running' };

  fireJob(job, currentOpts).catch((e) => console.error('[scheduler]', e));
  return { started: true };
}

export async function stopScheduler(stopOpts: StopSchedulerOpts = {}): Promise<void> {
  closeWatchers();
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  const waitMs = stopOpts.waitMs ?? 30_000;
  const deadline = Date.now() + waitMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  inFlight.clear();
  currentOpts = null;
}
