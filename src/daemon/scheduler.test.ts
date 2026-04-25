import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { startScheduler, stopScheduler } from './scheduler';

function fakeChild(autoClose = true) {
  const c = new EventEmitter() as any;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  if (autoClose) setImmediate(() => c.emit('close', 0));
  return c;
}

describe('scheduler', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentio-sch-'));
  });
  afterEach(async () => {
    await stopScheduler({ waitMs: 0 });
    rmSync(root, { recursive: true, force: true });
  });

  test('fires a schedule on startup (first-run via prev + absent state)', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 1\nenabled: true\nhost: h1\n---\nbody\n');

    const spawns: { folder: string }[] = [];
    const spawner = (_cmd: string, _args: string[], opts: { cwd: string }) => {
      spawns.push({ folder: opts.cwd });
      return fakeChild();
    };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 1000,  // irrelevant; we only check after initial tick
      spawner,
      claudePath: '/bin/true',
      now: () => new Date(),
    });

    // Poll up to 3s for the spawner to be called — initial tick fires asynchronously.
    const deadline = Date.now() + 3000;
    while (spawns.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(spawns.length).toBe(1);
    expect(spawns[0].folder).toBe(root);
  });

  test('does not re-fire on the next tick if state.json shows a recent run', async () => {
    // Seed state.json with a lastRunAt after the most recent interval boundary.
    const now = new Date();
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 60\nenabled: true\nhost: h1\n---\nbody\n');

    mkdirSync(join(root, '.agentio'), { recursive: true });
    writeFileSync(join(root, '.agentio', 'state.json'),
      JSON.stringify({ x: { lastRunAt: now.toISOString() } }));

    const spawns: number[] = [];
    const spawner = () => { spawns.push(1); return fakeChild(); };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 50,
      spawner,
      claudePath: '/bin/true',
      now: () => now,
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(spawns.length).toBe(0);
  });

  test('catches up when lastRunAt is older than prev boundary', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 30\nenabled: true\nhost: h1\n---\n');

    // Anchor now at an interval boundary. Seed lastRunAt as 2h ago.
    const now = new Date('2026-04-24T10:00:00Z');
    const lastRunAt = new Date('2026-04-24T08:00:00Z').toISOString();
    mkdirSync(join(root, '.agentio'), { recursive: true });
    writeFileSync(join(root, '.agentio', 'state.json'),
      JSON.stringify({ x: { lastRunAt } }));

    const spawns: number[] = [];
    const spawner = () => { spawns.push(1); return fakeChild(); };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 1000,
      spawner,
      claudePath: '/bin/true',
      now: () => now,
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(spawns.length).toBe(1);
  });

  test('skips overlapping fires for the same id', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 1\nenabled: true\nhost: h1\n---\n');

    const spawns: number[] = [];
    let closeResolver: (() => void) | null = null;
    const spawner = () => {
      spawns.push(1);
      const c = new EventEmitter() as any;
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      closeResolver = () => c.emit('close', 0);
      return c;
    };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 30,
      spawner,
      claudePath: '/bin/true',
      now: () => new Date(),
    });

    // Let 3+ ticks go by while first fire is still in-flight.
    await new Promise((r) => setTimeout(r, 150));
    expect(spawns.length).toBe(1);

    // Cleanup: release the stuck child so stopScheduler doesn't hang.
    (closeResolver as (() => void) | null)?.();
  });

  test('does not fire manual schedules', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: manual\nenabled: true\nhost: h1\n---\n');

    const spawns: number[] = [];
    const spawner = () => { spawns.push(1); return fakeChild(); };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 50,
      spawner,
      claudePath: '/bin/true',
      now: () => new Date(),
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(spawns.length).toBe(0);
  });
});
