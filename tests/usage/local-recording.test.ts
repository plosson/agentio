import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync } from 'fs';
import { dirname } from 'path';
import { withTempVault } from '../helpers/vault';
import { getCredentials } from '../../src/auth/token-store';
import { closeUsageStore, usageDbPath } from '../../src/usage/store';
import { resetUsageContext, setUsageCommand, usageCommand } from '../../src/usage/context';

withTempVault('agentio-usage-local-', () => ({
  config: { profiles: { gmail: [{ name: 'work' }], slack: [{ name: 'ops' }] } },
  credentials: { gmail: { work: { access_token: 'at' } } },
}));

beforeEach(() => resetUsageContext());
afterEach(() => { resetUsageContext(); closeUsageStore(); });

async function events(): Promise<Array<Record<string, unknown>>> {
  const path = (await usageDbPath())!;
  const db = new Database(path, { create: true });
  try {
    db.exec('CREATE TABLE IF NOT EXISTS events (ts INTEGER)');
    return db.query('SELECT * FROM events').all() as Array<Record<string, unknown>>;
  } finally { db.close(); }
}

describe('local recording', () => {
  test('a command records each profile once, however often it reads it', async () => {
    setUsageCommand(['gmail', 'list']);
    for (let i = 0; i < 5; i++) await getCredentials('gmail', 'work');
    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ service: 'gmail', profile: 'work', command: 'gmail list', key_id: 'local', key_name: 'local', outcome: 'ok' });
  });

  test('a profile without credentials is recorded as not_found', async () => {
    setUsageCommand(['slack', 'send']);
    expect(await getCredentials('slack', 'ops')).toBeNull();
    expect((await events())[0]).toMatchObject({ profile: 'ops', outcome: 'not_found' });
  });

  test('no command context records nothing (the daemon, a library caller)', async () => {
    await getCredentials('gmail', 'work');
    expect(await events()).toEqual([]);
  });

  test('the daemon command never sets a context', () => {
    setUsageCommand(['daemon', 'start']);
    expect(usageCommand()).toBeNull();
  });

  test('a store that cannot be written does not change the credentials returned', async () => {
    setUsageCommand(['gmail', 'list']);
    closeUsageStore();
    const dir = dirname((await usageDbPath())!);
    chmodSync(dir, 0o500);
    try {
      expect(await getCredentials<{ access_token: string }>('gmail', 'work')).toEqual({ access_token: 'at' });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
