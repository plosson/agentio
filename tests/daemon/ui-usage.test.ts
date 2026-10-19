import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { lockVault } from '../../src/vault/vault';
import { createRequestHandler, type PeerSource } from '../../src/daemon/api';
import { clearSessions } from '../../src/daemon/session';
import { unlockLimiter } from '../../src/daemon/routes-ui';
import { stopKeepalive } from '../../src/daemon/keepalive';
import { stopSessions } from '../../src/daemon/sessions';
import { closeUsageStore, recordUsage } from '../../src/usage/store';

// Tests inject the client IP via X-Forwarded-For; trust it here as a fronting proxy would.
process.env.AGENTIO_TRUSTED_IP_HEADER = 'x-forwarded-for';

const PASSPHRASE = 'ui-usage-pass-1';
withTempVault('agentio-ui-usage-', () => ({ passphrase: PASSPHRASE }));

const peer: PeerSource = { requestIP: () => ({ address: '10.0.0.5' }) };
const handle = createRequestHandler({ version: 'test' });

beforeEach(() => {
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  clearSessions();
  unlockLimiter.reset();
});
// Unlocking through the UI starts the keepalive and the session supervisor; leave neither running for later files.
afterEach(async () => {
  stopKeepalive();
  await stopSessions();
  clearSessions();
  closeUsageStore();
});

function call(path: string, init: RequestInit & { ip?: string } = {}): Promise<Response> {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (ip) headers.set('x-forwarded-for', ip);
  return handle(new Request(`http://hub${path}`, { ...rest, headers }), peer);
}

function unlock(passphrase = PASSPHRASE, ip = '198.51.100.1'): Promise<Response> {
  return call('/ui/api/unlock', {
    method: 'POST',
    body: JSON.stringify({ passphrase }),
    headers: { 'content-type': 'application/json' },
    ip,
  });
}

async function cookieFrom(res: Response): Promise<string> {
  const set = res.headers.get('set-cookie') ?? '';
  return set.split(';')[0];
}

describe('GET /ui/api/usage', () => {
  test('needs a session', async () => {
    expect((await call('/ui/api/usage')).status).toBe(401);
  });

  test('returns the day-by-service counts and the three groupings for the last 30 days', async () => {
    await recordUsage({ service: 'gmail', profile: 'work', command: 'gmail list', host: 'box', keyId: 'k1', keyName: 'laptop', outcome: 'ok', version: '3.23.1' });
    const cookie = await cookieFrom(await unlock());
    const res = await call('/ui/api/usage', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['commands', 'daily', 'machines', 'profiles']);
    expect(body.daily).toEqual([{ day: new Date().toISOString().slice(0, 10), service: 'gmail', count: 1 }]);
    expect(body.machines[0]).toMatchObject({ host: 'box', keyId: 'k1', keyName: 'laptop', count: 1 });
    expect(body.profiles[0].group).toBe('gmail/work');
  });

  test('an empty store is four empty lists, not an error', async () => {
    const cookie = await cookieFrom(await unlock());
    const body = await (await call('/ui/api/usage', { headers: { cookie } })).json();
    expect(body).toEqual({ daily: [], machines: [], profiles: [], commands: [] });
  });
});
