import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { withTempVault } from '../helpers/vault';
import { lockVault, unlockVault } from '../../src/vault/vault';
import { createApiKey } from '../../src/auth/api-keys';
import { createRequestHandler } from '../../src/daemon/api';
import { v1AuthLimiter, v1KeyLimiter } from '../../src/daemon/routes-v1';
import { closeUsageStore, usageDbPath } from '../../src/usage/store';
import { resetUsageContext } from '../../src/usage/context';
import { INVALID, UNKNOWN, USAGE_HEADERS } from '../../src/usage/event';

const PASSPHRASE = 'hub-usage-pass-1';
withTempVault('agentio-usage-hub-', () => ({
  passphrase: PASSPHRASE,
  config: { profiles: { discourse: [{ name: 'bot' }, { name: 'other' }] } },
  credentials: { discourse: { bot: { botToken: 'b', channelId: '1' }, other: { botToken: 'o', channelId: '2' } } },
}));

const handle = createRequestHandler({ version: 'test' });
const peer = { requestIP: () => ({ address: '10.0.0.5' }) };
let token = '';
let keyId = '';

beforeEach(async () => {
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
  v1AuthLimiter.reset();
  v1KeyLimiter.reset();
  resetUsageContext();
  const issued = await createApiKey({ name: 'laptop', allowedProfiles: ['discourse/bot'], readOnly: false }, 'https://hub');
  token = issued.token;
  keyId = issued.key.id;
});

afterEach(() => closeUsageStore());

function creds(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return handle(new Request(`http://hub${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers } }), peer);
}

async function events(): Promise<Array<Record<string, unknown>>> {
  const db = new Database((await usageDbPath())!, { create: true });
  try {
    db.exec('CREATE TABLE IF NOT EXISTS events (ts INTEGER)');
    return db.query('SELECT * FROM events').all() as Array<Record<string, unknown>>;
  } finally { db.close(); }
}

describe('hub usage recording', () => {
  test('one request is exactly one event, with the key from the token and the client from the headers', async () => {
    const res = await creds('/v1/profiles/discourse/bot/credentials', {
      [USAGE_HEADERS.command]: 'discourse send',
      [USAGE_HEADERS.host]: 'agent-1.lan',
      [USAGE_HEADERS.version]: '3.24.0',
    });
    expect(res.status).toBe(200);
    const rows = await events();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      service: 'discourse', profile: 'bot', command: 'discourse send', host: 'agent-1.lan',
      key_id: keyId, key_name: 'laptop', outcome: 'ok', version: '3.24.0',
    });
  });

  test('a client that sends no headers (an older agentio) is recorded as unknown', async () => {
    await creds('/v1/profiles/discourse/bot/credentials');
    expect((await events())[0]).toMatchObject({ command: UNKNOWN, host: UNKNOWN, version: UNKNOWN });
  });

  test('hostile headers are recorded as invalid and the request still succeeds', async () => {
    const res = await creds('/v1/profiles/discourse/bot/credentials', {
      [USAGE_HEADERS.command]: "x'); DROP TABLE events; --",
      [USAGE_HEADERS.host]: 'h'.repeat(10_000),
      [USAGE_HEADERS.version]: 'not-a-version',
    });
    expect(res.status).toBe(200);
    expect((await events())[0]).toMatchObject({ command: INVALID, host: INVALID, version: UNKNOWN });
  });

  test('a profile the key may not use is refused and still recorded', async () => {
    const res = await creds('/v1/profiles/discourse/other/credentials', { [USAGE_HEADERS.command]: 'discourse send' });
    expect(res.status).toBe(403);
    expect((await events())[0]).toMatchObject({ profile: 'other', outcome: 'permission_denied' });
  });

  test('a bad token records nothing: the key is unknown, so the event has no owner', async () => {
    token = 'garbage';
    expect((await creds('/v1/profiles/discourse/bot/credentials')).status).toBe(401);
    expect(await events()).toEqual([]);
  });
});
