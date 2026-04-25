import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WatchedFolder } from '../types/config';
import {
  scanWatchedFolders,
  dueJobs,
  computeCatchUp,
  type ScheduledJob,
} from './scheduler-core';

describe('scanWatchedFolders', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentio-sch-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function write(rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  test('builds jobs from all watched folders', () => {
    write('foo.run.md',
      '---\nschedule:\n  type: interval\n  intervalMinutes: 30\nenabled: true\nhost: my-host\n---\nbody\n');
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'my-host', new Date('2026-04-24T10:00:00Z'));
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe('foo');
    expect(jobs[0].folder).toBe(root);
    expect(jobs[0].config.schedule.type).toBe('interval');
  });

  test('skips files without host field (host is required)', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\nenabled: true\n---\n');
    // Note: no host field
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'me', new Date());
    expect(jobs.length).toBe(0);
  });

  test('skips folders pinned to other hosts', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\n---\n');
    const folders: WatchedFolder[] = [{ path: root, host: 'other-host', addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'my-host', new Date());
    expect(jobs.length).toBe(0);
  });

  test('skips files pinned to other hosts', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\nhost: elsewhere\n---\n');
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'me', new Date());
    expect(jobs.length).toBe(0);
  });

  test('skips disabled schedules', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\nenabled: false\n---\n');
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'me', new Date());
    expect(jobs.length).toBe(0);
  });
});

describe('dueJobs', () => {
  test('returns jobs whose nextRun <= now', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    const jobs: ScheduledJob[] = [
      { folder: '/a', id: 'x', filePath: '/a/x.run.md',
        config: {} as any, nextRun: new Date('2026-04-24T09:59:00Z') },
      { folder: '/a', id: 'y', filePath: '/a/y.run.md',
        config: {} as any, nextRun: new Date('2026-04-24T10:01:00Z') },
    ];
    const due = dueJobs(jobs, now);
    expect(due.map((j) => j.id)).toEqual(['x']);
  });
});

describe('computeCatchUp', () => {
  test('returns true when lastRunAt is before the previous expected fire', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    const lastRunAt = new Date('2026-04-24T08:00:00Z').toISOString();
    const result = computeCatchUp(
      { type: 'interval', intervalMinutes: 30 },
      lastRunAt,
      now,
    );
    expect(result).toBe(true);
  });

  test('returns false when lastRunAt is after the previous expected fire', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    const lastRunAt = new Date('2026-04-24T09:45:00Z').toISOString();
    const result = computeCatchUp(
      { type: 'interval', intervalMinutes: 30 },
      lastRunAt,
      now,
    );
    expect(result).toBe(false);
  });

  test('returns false when lastRunAt is undefined (first run)', () => {
    const result = computeCatchUp(
      { type: 'interval', intervalMinutes: 30 },
      undefined,
      new Date(),
    );
    expect(result).toBe(false);
  });

  test('returns false for manual schedules', () => {
    const result = computeCatchUp(
      { type: 'manual' },
      new Date('2026-01-01').toISOString(),
      new Date('2026-04-24'),
    );
    expect(result).toBe(false);
  });
});
