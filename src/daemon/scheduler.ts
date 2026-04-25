import type { WatchedFolder } from '../types/config';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
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
}

let tickInterval: ReturnType<typeof setInterval> | null = null;
const inFlight: Set<string> = new Set();
let currentOpts: StartSchedulerOpts | null = null;

function jobKey(j: ScheduledJob): string {
  return `${j.folder}::${j.id}`;
}

async function fireJob(job: ScheduledJob, opts: StartSchedulerOpts): Promise<void> {
  const key = jobKey(job);
  if (inFlight.has(key)) return;  // guard against concurrent fires
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
  const jobs = scanWatchedFolders(opts.watchedFolders, host, now);

  for (const j of jobs) {
    const key = jobKey(j);
    if (inFlight.has(key)) {
      console.log(`[scheduler] skipped ${j.folder}::${j.id} (still running)`);
      continue;
    }
    const prev = prevRun(j.config.schedule, now);
    if (!prev) continue;  // manual, no scheduled fire
    const state = await readState(j.folder).catch(() => ({} as Record<string, { lastRunAt?: string }>));
    const lastRunAtIso = state[j.id]?.lastRunAt;
    const shouldFire = !lastRunAtIso || new Date(lastRunAtIso).getTime() < prev.getTime();
    if (shouldFire) {
      // fire-and-forget
      fireJob(j, opts).catch((e) => console.error('[scheduler]', e));
    }
  }
}

export async function startScheduler(opts: StartSchedulerOpts): Promise<void> {
  if (tickInterval) throw new Error('scheduler already started');
  currentOpts = opts;
  const intervalMs = opts.tickIntervalMs ?? 60_000;
  await tick(opts);
  tickInterval = setInterval(() => { tick(opts).catch(console.error); }, intervalMs);
}

export async function reloadScheduler(watchedFolders: WatchedFolder[]): Promise<void> {
  if (!currentOpts) return;
  currentOpts = { ...currentOpts, watchedFolders };
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
}

export async function listSchedulerJobs(): Promise<SchedulerJobView[]> {
  if (!currentOpts) return [];
  const host = currentOpts.currentHost ?? getCurrentHost();
  const now = (currentOpts.now ?? (() => new Date()))();
  const { describeSchedule } = await import('../services/schedule/describe');
  const jobs = scanWatchedFolders(currentOpts.watchedFolders, host, now);
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
