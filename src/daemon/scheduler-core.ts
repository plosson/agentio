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
}

/**
 * Scan all watched folders, parse each `.run.md`, and build ScheduledJobs
 * for schedules that are enabled and match the current host.
 * Parse errors are silently skipped (caller logs).
 */
export function scanWatchedFolders(
  folders: WatchedFolder[],
  currentHost: string,
  now: Date,
): ScheduledJob[] {
  const out: ScheduledJob[] = [];
  for (const f of folders) {
    if (f.host && f.host !== currentHost) continue;
    let files;
    try { files = walkRunFiles(f.path); } catch { continue; }
    for (const file of files) {
      let raw: string;
      try { raw = readFileSync(file.path, 'utf-8'); } catch { continue; }
      let parsed;
      try { parsed = parseFrontmatter(raw); } catch { continue; }
      let cfg: FrontmatterConfig;
      try { cfg = mergeConfig({}, parsed.config); } catch { continue; }
      if (!cfg.enabled) continue;
      if (!cfg.host) {
        console.warn(`[scheduler] skipping ${file.path}: missing required \`host\` field`);
        continue;
      }
      if (cfg.host !== currentHost) continue;
      const next = nextRuns(cfg.schedule, 1, now)[0];
      if (!next) continue;  // manual schedules
      out.push({
        folder: f.path,
        id: file.id,
        filePath: file.path,
        config: cfg,
        nextRun: next,
      });
    }
  }
  return out;
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
