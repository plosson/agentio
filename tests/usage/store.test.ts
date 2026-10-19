import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { withTempVault } from '../helpers/vault';
import { closeUsageStore, DAY_MS, queryUsage, recordUsage, usageDbPath } from '../../src/usage/store';
import { INVALID, UNKNOWN, normalizeEvent, type UsageInput } from '../../src/usage/event';

withTempVault('agentio-usage-store-', () => ({}));

afterEach(() => closeUsageStore());

const base = (over: Partial<UsageInput> = {}): UsageInput => ({
  service: 'gmail', profile: 'work', command: 'gmail list', host: 'box.lan',
  keyId: 'local', keyName: 'local', outcome: 'ok', version: '3.23.1', ...over,
});

const rows = async () => {
  const path = (await usageDbPath())!;
  const db = new Database(path, { readonly: true });
  try { return db.query('SELECT * FROM events ORDER BY ts').all() as Array<Record<string, unknown>>; } finally { db.close(); }
};

describe('normalizeEvent', () => {
  test('missing fields are unknown, never empty', () => {
    const e = normalizeEvent(base({ command: null, host: undefined, version: '' }));
    expect(e.command).toBe(UNKNOWN);
    expect(e.host).toBe(UNKNOWN);
    expect(e.version).toBe(UNKNOWN);
  });

  test('injection and oversize values are invalid', () => {
    const e = normalizeEvent(base({
      command: "gmail list'; DROP TABLE events; --",
      host: 'box\nX-Evil: 1',
      profile: 'work\u0000',
      keyName: 'ünïcødé\nname',
    }));
    expect(e.command).toBe(INVALID);
    expect(e.host).toBe(INVALID);
    expect(e.profile).toBe(INVALID);
    expect(e.keyName).toBe(INVALID);
    expect(normalizeEvent(base({ command: 'a'.repeat(10_000) })).command).toBe(INVALID);
    expect(normalizeEvent(base({ host: 'h'.repeat(65) })).host).toBe(INVALID);
  });

  test('a version that is not semver is unknown, not invalid', () => {
    expect(normalizeEvent(base({ version: 'latest' })).version).toBe(UNKNOWN);
    expect(normalizeEvent(base({ version: '3.23.1-beta.2' })).version).toBe('3.23.1-beta.2');
  });

  test('an outcome that is not a lowercase code is error', () => {
    expect(normalizeEvent(base({ outcome: 'PERMISSION_DENIED' })).outcome).toBe('error');
    expect(normalizeEvent(base({ outcome: 'permission_denied' })).outcome).toBe('permission_denied');
  });
});

describe('recordUsage', () => {
  test('writes next to the vault, and a hostile value never breaks a query', async () => {
    await recordUsage(base({ command: "x'); DELETE FROM events; --" }));
    await recordUsage(base());
    const path = (await usageDbPath())!;
    const { readPointer } = await import('../../src/vault/pointer');
    expect(dirname(path)).toBe(dirname((await readPointer())!));
    expect(existsSync(path)).toBe(true);
    expect((await rows()).map((r) => r.command)).toEqual([INVALID, 'gmail list']);
  });

  test('never throws when the store cannot be written', async () => {
    const dir = dirname((await usageDbPath())!);
    chmodSync(dir, 0o500);
    try {
      await expect(recordUsage(base())).resolves.toBeUndefined();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test('a corrupt store is set aside and a new one records', async () => {
    const path = (await usageDbPath())!;
    writeFileSync(path, 'this is not a sqlite file at all, just text padding '.repeat(100));
    await recordUsage(base());
    expect((await rows()).length).toBe(1);
    expect(readdirSync(dirname(path)).some((f) => f.startsWith('usage.db.corrupt-'))).toBe(true);
  });

  test('a write blocked by another process does not throw', async () => {
    await recordUsage(base());
    const other = new Database((await usageDbPath())!);
    other.exec('BEGIN IMMEDIATE');
    try {
      await expect(recordUsage(base())).resolves.toBeUndefined();
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    await recordUsage(base());
    expect((await rows()).length).toBeGreaterThanOrEqual(2);
  });

  test('rows older than 90 days are pruned, younger ones kept', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now - 91 * DAY_MS, profile: 'old' }));
    await recordUsage(base({ ts: now - 89 * DAY_MS, profile: 'young' }));
    await recordUsage(base({ ts: now, profile: 'today' }));
    expect((await rows()).map((r) => r.profile)).toEqual(['young', 'today']);
  });

  test('no vault pointer: nothing is written, nothing throws', async () => {
    const { deletePointer } = await import('../../src/vault/pointer');
    await deletePointer();
    await expect(recordUsage(base())).resolves.toBeUndefined();
    expect(await usageDbPath()).toBeNull();
  });
});

describe('queryUsage', () => {
  test('groups, counts failures and orders by count', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now - 1000 }));
    await recordUsage(base({ ts: now - 900, outcome: 'permission_denied' }));
    await recordUsage(base({ ts: now - 800, service: 'slack', profile: 'ops', command: 'slack send' }));
    await recordUsage(base({ ts: now - 10 * DAY_MS, command: 'gmail send' }));

    const byCommand = await queryUsage({ by: 'command', since: 7 * DAY_MS, now });
    expect(byCommand).toEqual([
      { group: 'gmail list', count: 2, failures: 1, lastSeen: now - 900 },
      { group: 'slack send', count: 1, failures: 0, lastSeen: now - 800 },
    ]);
    expect((await queryUsage({ by: 'profile', since: 30 * DAY_MS, now })).map((r) => r.group)).toEqual(['gmail/work', 'slack/ops']);
    expect((await queryUsage({ by: 'machine', since: 7 * DAY_MS, now }))[0]!.group).toBe('box.lan · local');
  });

  test('an unknown grouping is refused before any SQL is built', async () => {
    await recordUsage(base());
    await expect(queryUsage({ by: 'command; DROP TABLE events' as never, since: DAY_MS })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  test('a missing store is an empty answer and creates no file', async () => {
    expect(await queryUsage({ by: 'command', since: DAY_MS })).toEqual([]);
    expect(existsSync((await usageDbPath())!)).toBe(false);
  });
});
