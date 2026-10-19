import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { withTempVault } from '../helpers/vault';
import { closeUsageStore, DAY_MS, queryDailyByService, queryMachines, queryUsage, recordUsage, usageDbPath } from '../../src/usage/store';
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

  test('owner-chosen names may hold accents and Unicode, but no control characters', () => {
    expect(normalizeEvent(base({ keyName: 'ünïcødé' })).keyName).toBe('ünïcødé');
    expect(normalizeEvent(base({ profile: 'Pascal’s laptop', keyName: 'Bureau – iMac' }))).toMatchObject({ profile: 'Pascal’s laptop', keyName: 'Bureau – iMac' });
    for (const bad of ['ünïcødé\nname', 'work\u0000', 'a\u2028b', 'x'.repeat(129), '\x7f']) {
      expect(normalizeEvent(base({ service: bad, profile: bad, keyId: bad, keyName: bad }))).toMatchObject({ service: INVALID, profile: INVALID, keyId: INVALID, keyName: INVALID });
    }
    expect(normalizeEvent(base({ profile: 'x'.repeat(128) })).profile).toBe('x'.repeat(128));
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

  test('the store and its journal files are private to the user', async () => {
    await recordUsage(base());
    const path = (await usageDbPath())!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
    }
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

  test('a renamed key stays one row under its latest name; two keys sharing a name stay two', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now - 50, keyId: 'k1', keyName: 'cursor-box' }));
    await recordUsage(base({ ts: now - 40, keyId: 'k1', keyName: 'cursor-box', outcome: 'auth_expired' }));
    await recordUsage(base({ ts: now - 30, keyId: 'k1', keyName: 'Grok Bot' }));
    await recordUsage(base({ ts: now - 20, keyId: 'k2', keyName: 'Grok Bot' }));

    expect(await queryUsage({ by: 'key', since: DAY_MS, now })).toEqual([
      { group: 'Grok Bot', count: 3, failures: 1, lastSeen: now - 30 },
      { group: 'Grok Bot', count: 1, failures: 0, lastSeen: now - 20 },
    ]);
    expect((await queryUsage({ by: 'machine', since: DAY_MS, now })).map((r) => [r.group, r.count])).toEqual([
      ['box.lan · Grok Bot', 3], ['box.lan · Grok Bot', 1],
    ]);
  });

  test('the latest name comes from any time, so a rename before the window still shows', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now - 2 * DAY_MS, keyId: 'k1', keyName: 'old' }));
    await recordUsage(base({ ts: now - 10 * DAY_MS, keyId: 'k1', keyName: 'older' }));
    await recordUsage(base({ ts: now - 1000, keyId: 'k1', keyName: 'new' }));
    expect(await queryUsage({ by: 'key', since: 3 * DAY_MS, now })).toEqual([{ group: 'new', count: 2, failures: 0, lastSeen: now - 1000 }]);
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

describe('queryDailyByService', () => {
  test('splits each UTC day by service, oldest day first, and leaves out older days', async () => {
    const midnight = Date.UTC(2026, 9, 19);
    const now = midnight + 12 * 3_600_000;
    await recordUsage(base({ ts: midnight - 1 }));
    await recordUsage(base({ ts: midnight - 2, service: 'slack' }));
    await recordUsage(base({ ts: midnight }));
    await recordUsage(base({ ts: midnight + 1, outcome: 'not_found' }));
    await recordUsage(base({ ts: midnight + 2, service: 'slack' }));
    await recordUsage(base({ ts: now - 40 * DAY_MS }));

    expect(await queryDailyByService({ since: 30 * DAY_MS, now })).toEqual([
      { day: '2026-10-18', service: 'gmail', count: 1 },
      { day: '2026-10-18', service: 'slack', count: 1 },
      { day: '2026-10-19', service: 'gmail', count: 2 },
      { day: '2026-10-19', service: 'slack', count: 1 },
    ]);
  });

  test('a missing store is an empty answer and creates no file', async () => {
    expect(await queryDailyByService({ since: DAY_MS })).toEqual([]);
    expect(existsSync((await usageDbPath())!)).toBe(false);
  });
});

describe('queryMachines', () => {
  test('carries the key id, and two keys with one name on one host stay apart', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now - 30, keyId: 'k1', keyName: 'laptop' }));
    await recordUsage(base({ ts: now - 20, keyId: 'k1', keyName: 'laptop', outcome: 'auth_expired' }));
    await recordUsage(base({ ts: now - 10, keyId: 'k2', keyName: 'laptop' }));

    expect(await queryMachines({ since: DAY_MS, now })).toEqual([
      { group: 'box.lan · laptop', host: 'box.lan', keyId: 'k1', keyName: 'laptop', count: 2, failures: 1, lastSeen: now - 20 },
      { group: 'box.lan · laptop', host: 'box.lan', keyId: 'k2', keyName: 'laptop', count: 1, failures: 0, lastSeen: now - 10 },
    ]);
  });

  test('a renamed key is one machine row, named as last used', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now - 30, host: 'grok-vm', keyId: 'k1', keyName: 'cursor-box' }));
    await recordUsage(base({ ts: now - 10, host: 'grok-vm', keyId: 'k1', keyName: 'Grok Bot' }));
    await recordUsage(base({ ts: now - 5, host: 'unknown', keyId: 'k1', keyName: 'Grok Bot' }));
    expect((await queryMachines({ since: DAY_MS, now })).map((r) => [r.host, r.keyId, r.keyName, r.count])).toEqual([
      ['grok-vm', 'k1', 'Grok Bot', 2], ['unknown', 'k1', 'Grok Bot', 1],
    ]);
  });

  test('hostile values come back as stored text, never as SQL', async () => {
    const now = Date.now();
    await recordUsage(base({ ts: now, host: "x'); DROP TABLE events; --", keyId: "k' OR 1=1", keyName: '<script>' }));
    const [row] = await queryMachines({ since: DAY_MS, now });
    expect(row).toMatchObject({ host: 'invalid', keyId: "k' OR 1=1", keyName: '<script>', count: 1 });
    expect(await queryMachines({ since: DAY_MS, now })).toHaveLength(1);
  });

  test('a missing store is an empty answer and creates no file', async () => {
    expect(await queryMachines({ since: DAY_MS })).toEqual([]);
    expect(existsSync((await usageDbPath())!)).toBe(false);
  });
});
