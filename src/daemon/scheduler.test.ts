import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { startScheduler, stopScheduler, _testHooks } from './scheduler';

function fakeChild() {
  const c = new EventEmitter() as any;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  setImmediate(() => c.emit('close', 0));
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

  test('fires a due interval schedule on tick', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 1\nenabled: true\n---\nbody\n');

    const spawns: { folder: string; id: string }[] = [];
    const spawner = (_cmd: string, _args: string[], opts: { cwd: string }) => {
      spawns.push({ folder: opts.cwd, id: 'x' });
      return fakeChild();
    };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 50,
      spawner,
      claudePath: '/bin/true',  // non-null so runSchedule proceeds
      now: () => new Date(),
    });

    // Wait two ticks
    await new Promise((r) => setTimeout(r, 200));

    expect(spawns.length).toBeGreaterThanOrEqual(1);
    expect(spawns[0].folder).toBe(root);
  });

  test('skips a second fire when a run is still in flight', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 1\nenabled: true\n---\nbody\n');

    let closeResolver: (() => void) | null = null;
    const counter = { n: 0 };
    const spawner = () => {
      counter.n += 1;
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

    await new Promise((r) => setTimeout(r, 200));
    expect(counter.n).toBe(1);  // in-flight, not re-spawned
    (closeResolver as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 100));
    expect(counter.n).toBeGreaterThan(1);  // now eligible again
  });
});
