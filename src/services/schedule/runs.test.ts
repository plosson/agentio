import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRuns } from './runs';

describe('listRuns', () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'agentio-runs-')); });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  test('returns empty when no runs dir', () => {
    expect(listRuns(folder, 'foo')).toEqual([]);
  });

  test('parses summary line from log tail', () => {
    const dir = join(folder, '.agentio', 'runs', 'foo');
    mkdirSync(dir, { recursive: true });
    const summary = { type: 'summary', status: 'succeeded', exitCode: 0, durationMs: 1234, sessionId: 'abc', startedAt: '2026-04-22T10:00:00Z', endedAt: '2026-04-22T10:00:01Z' };
    writeFileSync(join(dir, '2026-04-22T10-00-00Z.log'),
      'some logs\n' + JSON.stringify(summary) + '\n');
    const runs = listRuns(folder, 'foo');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].sessionId).toBe('abc');
  });

  test('newest first', () => {
    const dir = join(folder, '.agentio', 'runs', 'foo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-04-22T10-00-00Z.log'), '');
    writeFileSync(join(dir, '2026-04-23T10-00-00Z.log'), '');
    const runs = listRuns(folder, 'foo');
    expect(runs[0].file).toMatch(/2026-04-23/);
  });
});
