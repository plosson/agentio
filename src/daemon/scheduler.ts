import type { WatchedFolder } from '../types/config';
import { readFile } from 'fs/promises';
import { scanWatchedFolders, dueJobs, computeCatchUp, type ScheduledJob } from './scheduler-core';
import { runSchedule, type Spawner } from '../services/schedule/runner';
import { readState } from '../services/schedule/state';
import { parseFrontmatter } from '../services/schedule/frontmatter';
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
let inFlight: Set<string> = new Set();  // keys: `${folder}::${id}`
let pendingFire: Map<string, ScheduledJob> = new Map();  // skipped-while-in-flight jobs
let catchUpApplied: Set<string> = new Set();
let currentOpts: StartSchedulerOpts | null = null;

function jobKey(j: ScheduledJob): string {
  return `${j.folder}::${j.id}`;
}

async function fireJob(job: ScheduledJob, opts: StartSchedulerOpts): Promise<void> {
  const key = jobKey(job);
  if (inFlight.has(key)) {
    console.log(`[scheduler] skipped ${job.id} (still running)`);
    pendingFire.set(key, job);
    return;
  }
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
    console.error(`[scheduler] fire failed for ${job.id}:`, e instanceof Error ? e.message : e);
  } finally {
    inFlight.delete(key);
    // If a tick was skipped while we were in-flight, fire immediately now.
    const pending = pendingFire.get(key);
    if (pending) {
      pendingFire.delete(key);
      fireJob(pending, opts).catch(console.error);
    }
  }
}

async function tick(opts: StartSchedulerOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))();
  const host = opts.currentHost ?? getCurrentHost();
  const jobs = scanWatchedFolders(opts.watchedFolders, host, now);

  // Missed-runs catch-up and first-run fires, one per id per startup.
  for (const j of jobs) {
    const key = jobKey(j);
    if (catchUpApplied.has(key)) {
      // If this job is currently in-flight, note that a tick passed so we re-fire on completion.
      if (inFlight.has(key)) pendingFire.set(key, j);
      continue;
    }
    const state = await readState(j.folder).catch(() => ({} as Record<string, never>));
    const lastRunAt = state[j.id]?.lastRunAt;
    if (computeCatchUp(j.config.schedule, lastRunAt, now)) {
      console.log(`[scheduler] catch-up firing ${j.id}`);
      fireJob(j, opts);  // fire-and-forget
    } else if (!lastRunAt && j.config.schedule.type !== 'manual' && prevRun(j.config.schedule, now) !== null) {
      // First-ever run: schedule has a past alignment point but has never run.
      console.log(`[scheduler] first-run firing ${j.id}`);
      fireJob(j, opts);  // fire-and-forget
    }
    catchUpApplied.add(key);
  }

  // Due-this-tick fires.
  const due = dueJobs(jobs, now);
  for (const j of due) {
    fireJob(j, opts);  // fire-and-forget
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

export async function stopScheduler(opts?: { waitMs?: number }): Promise<void> {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  // Wait up to waitMs (default 30s) for in-flight runs to finish gracefully.
  const waitMs = opts?.waitMs ?? 30_000;
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  inFlight.clear();
  pendingFire.clear();
  catchUpApplied.clear();
  currentOpts = null;
}

export const _testHooks = {
  getInFlight: () => new Set(inFlight),
};
