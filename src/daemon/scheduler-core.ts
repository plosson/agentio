import { readFileSync } from 'fs';
import type { WatchedFolder } from '../types/config';
import type { FrontmatterConfig, Schedule } from '../types/schedule';
import { walkRunFiles } from '../services/schedule/walker';
import { mergeConfig, parseFrontmatter } from '../services/schedule/frontmatter';
import { nextRuns, prevRun } from '../services/schedule/schedule-calculator';

export interface ScheduledJob {
  folder: string;
  id: string;
  filePath: string;
  config: FrontmatterConfig;
  nextRun: Date;
  /** True when scan was run with allHosts and this job's host pin doesn't match currentHost. */
  offHost?: boolean;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ScanResult {
  jobs: ScheduledJob[];
  skipped: SkippedFile[];
}

export interface ScanOptions {
  /** Include jobs whose host pin doesn't match currentHost (marked offHost=true). */
  allHosts?: boolean;
}

/**
 * Scan all watched folders, parse each `.run.md`, and build ScheduledJobs
 * for schedules that are enabled and (unless allHosts) match the current host.
 * Returns skipped files (e.g. missing required host) so callers can surface them.
 */
export function scanWatchedFolders(
  folders: WatchedFolder[],
  currentHost: string,
  now: Date,
  opts: ScanOptions = {},
): ScanResult {
  const jobs: ScheduledJob[] = [];
  const skipped: SkippedFile[] = [];
  for (const f of folders) {
    if (!opts.allHosts && f.host && f.host !== currentHost) continue;
    let files;
    try { files = walkRunFiles(f.path); } catch { continue; }
    for (const file of files) {
      let raw: string;
      try { raw = readFileSync(file.path, 'utf-8'); } catch (e) {
        skipped.push({ path: file.path, reason: `read failed: ${(e as Error).message}` });
        continue;
      }
      let parsed;
      try { parsed = parseFrontmatter(raw); } catch (e) {
        skipped.push({ path: file.path, reason: `frontmatter parse failed: ${(e as Error).message}` });
        continue;
      }
      let cfg: FrontmatterConfig;
      try { cfg = mergeConfig({}, parsed.config); } catch (e) {
        skipped.push({ path: file.path, reason: (e as Error).message });
        continue;
      }
      if (!cfg.enabled) continue;
      if (!cfg.host) {
        skipped.push({ path: file.path, reason: 'missing required `host:` field' });
        continue;
      }
      const offHost = cfg.host !== currentHost;
      if (offHost && !opts.allHosts) continue;
      const next = nextRuns(cfg.schedule, 1, now)[0];
      if (!next) continue;
      jobs.push({
        folder: f.path,
        id: file.id,
        filePath: file.path,
        config: cfg,
        nextRun: next,
        ...(offHost ? { offHost: true } : {}),
      });
    }
  }
  return { jobs, skipped };
}

/** Return jobs whose nextRun <= now. */
export function dueJobs(jobs: ScheduledJob[], now: Date): ScheduledJob[] {
  return jobs.filter((j) => j.nextRun.getTime() <= now.getTime());
}

/**
 * Decide if a schedule needs a catch-up fire.
 * True iff the most recent expected fire before `now` is *after* `lastRunAt`.
 */
export function computeCatchUp(
  schedule: Schedule,
  lastRunAtIso: string | undefined,
  now: Date,
): boolean {
  if (schedule.type === 'manual') return false;
  if (!lastRunAtIso) return false;
  const prev = prevRun(schedule, now);
  if (!prev) return false;
  return new Date(lastRunAtIso).getTime() < prev.getTime();
}
