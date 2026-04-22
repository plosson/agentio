import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readState, writeState, updateState } from './state';

describe('state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentio-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads empty object when file missing', async () => {
    expect(await readState(dir)).toEqual({});
  });

  test('writes then reads', async () => {
    await writeState(dir, { foo: { sessionId: 'abc', lastRunAt: '2026-04-22T00:00:00Z' } });
    expect(await readState(dir)).toEqual({ foo: { sessionId: 'abc', lastRunAt: '2026-04-22T00:00:00Z' } });
  });

  test('updateState merges', async () => {
    await writeState(dir, { foo: { sessionId: 'old' } });
    await updateState(dir, 'foo', { lastRunAt: '2026-04-22T01:00:00Z' });
    expect(await readState(dir)).toEqual({ foo: { sessionId: 'old', lastRunAt: '2026-04-22T01:00:00Z' } });
  });

  test('returns empty for corrupt json', async () => {
    await writeState(dir, {}); // creates .agentio/
    writeFileSync(join(dir, '.agentio', 'state.json'), '{not json');
    expect(await readState(dir)).toEqual({});
  });
});
