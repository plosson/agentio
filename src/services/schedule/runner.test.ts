import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSchedule, type Spawner } from './runner';
import type { FrontmatterConfig } from '../../types/schedule';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): void {}
}

function makeSpawner(lines: string[], exitCode: number): { spawner: Spawner; child: FakeChild } {
  const child = new FakeChild();
  const spawner: Spawner = () => {
    setImmediate(() => {
      for (const l of lines) child.stdout.emit('data', Buffer.from(l + '\n'));
      child.emit('close', exitCode);
    });
    return child as unknown as ReturnType<Spawner>;
  };
  return { spawner, child };
}

const config: FrontmatterConfig = {
  schedule: { type: 'manual' },
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  sessionMode: 'new',
  enabled: true,
};

describe('runSchedule', () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'agentio-run-')); });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  test('captures session_id from init event, writes summary line, returns exit code', async () => {
    const { spawner } = makeSpawner(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ],
      0
    );
    const { exitCode, logPath } = await runSchedule({
      folder, id: 'test', promptBody: 'hi', config, spawner,
      claudePath: '/fake/claude', now: () => new Date('2026-04-22T10:00:00Z'),
    });
    expect(exitCode).toBe(0);
    const log = readFileSync(logPath, 'utf-8');
    const summary = JSON.parse(log.trim().split('\n').pop()!);
    expect(summary.type).toBe('summary');
    expect(summary.sessionId).toBe('sess-123');
    expect(summary.exitCode).toBe(0);
  });

  test('failure path: non-zero exit propagated', async () => {
    const { spawner } = makeSpawner([], 2);
    const { exitCode } = await runSchedule({
      folder, id: 'test', promptBody: 'hi', config, spawner,
      claudePath: '/fake/claude', now: () => new Date('2026-04-22T10:00:00Z'),
    });
    expect(exitCode).toBe(2);
  });

  test('creates .agentio/runs/<id>/<ts>.log', async () => {
    const { spawner } = makeSpawner([], 0);
    await runSchedule({
      folder, id: 'test', promptBody: 'hi', config, spawner,
      claudePath: '/fake/claude', now: () => new Date('2026-04-22T10:00:00Z'),
    });
    const runsDir = join(folder, '.agentio', 'runs', 'test');
    expect(existsSync(runsDir)).toBe(true);
    expect(readdirSync(runsDir).length).toBeGreaterThan(0);
  });
});
