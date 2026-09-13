import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { lockVault } from '../vault/vault';
import { createRequestHandler, type PeerSource } from './api';
import { clearSessions } from './session';
import { getCredentials } from '../auth/token-store';
import { unlockLimiter } from './routes-ui';
import { deviceLimiter } from './routes-v1';
import { resetDeviceAuth } from './device-auth';

const PASSPHRASE = 'hub-passphrase-123';

const peer: PeerSource = { requestIP: () => ({ address: '10.0.0.5' }) };
const handle = createRequestHandler({ version: 'test' });

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

withTempVault('agentio-api-test-', () => ({
  passphrase: PASSPHRASE,
  config: { profiles: { telegram: [{ name: 'bot', readOnly: true }], slack: [{ name: 'empty' }] } },
  credentials: { telegram: { bot: { botToken: 't', channelId: '1' } } },
}));

beforeEach(() => {
  // seedVault leaves the vault unlocked through the env var; the daemon starts locked.
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  clearSessions();
  unlockLimiter.reset();
  deviceLimiter.reset();
  resetDeviceAuth();
});

afterEach(() => clearSessions());

describe('daemon HTTP surface', () => {
  test('/health is public and reports the lock state', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', locked: true });
  });

  test('the root redirects to the admin UI', async () => {
    const res = await call('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://hub/ui');
  });

  test('the page and the session probe are public', async () => {
    const page = await call('/ui');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('agentio vault');

    const probe = await call('/ui/api/session');
    expect(await probe.json()).toEqual({ authenticated: false, locked: true });
  });

  test('vault routes need a session', async () => {
    expect((await call('/ui/api/status')).status).toBe(401);
    expect((await call('/ui/api/profiles')).status).toBe(401);
    expect((await call('/ui/api/lock', { method: 'POST' })).status).toBe(401);
  });

  test('wrong passphrase is 401 and leaves the vault locked', async () => {
    const res = await unlock('not-it');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'AUTH_FAILED' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await (await call('/health')).json()).toMatchObject({ locked: true });
  });

  test('unlock is rate limited per address', async () => {
    for (let i = 0; i < 5; i++) expect((await unlock('wrong', '203.0.113.7')).status).toBe(401);
    expect((await unlock('wrong', '203.0.113.7')).status).toBe(429);
    // Another address, and even the right passphrase from the limited one, are judged separately.
    expect((await unlock(PASSPHRASE, '203.0.113.8')).status).toBe(200);
    expect((await unlock(PASSPHRASE, '203.0.113.7')).status).toBe(429);
  });

  test('right passphrase unlocks, sets a session, and opens the vault routes', async () => {
    const res = await unlock();
    expect(res.status).toBe(200);
    const cookie = await cookieFrom(res);
    expect(cookie).toMatch(/^agentio_session=/);
    // Plain http here, so the cookie must not be Secure or the browser would drop it.
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
    const viaProxy = await call('/ui/api/unlock', { method: 'POST', body: JSON.stringify({ passphrase: PASSPHRASE }), headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, ip: '198.51.100.2' });
    expect(viaProxy.headers.get('set-cookie')).toContain('Secure');
    expect(await (await call('/health')).json()).toMatchObject({ locked: false });

    const profiles = await call('/ui/api/profiles', { headers: { cookie } });
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toEqual({
      profiles: [{ service: 'slack', name: 'empty', readOnly: false }, { service: 'telegram', name: 'bot', readOnly: true }],
    });

    const status = await call('/ui/api/status?test=false', { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      version: 'test',
      services: { slack: [{ profile: 'empty', status: 'no-creds' }], telegram: [{ profile: 'bot', readOnly: true, status: 'skipped' }] },
    });
  });

  test('a single profile can be tested on demand', async () => {
    const cookie = await cookieFrom(await unlock());
    // No credentials stored: reported without any network call.
    const empty = await call('/ui/api/profiles/slack/empty/status', { headers: { cookie } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ profile: 'empty', status: 'no-creds' });
    expect((await call('/ui/api/profiles/slack/nope/status', { headers: { cookie } })).status).toBe(404);
    expect((await call('/ui/api/profiles/slack/empty/status')).status).toBe(401);
  });

  test('lock forgets the vault and every session', async () => {
    const cookie = await cookieFrom(await unlock());
    const locked = await call('/ui/api/lock', { method: 'POST', headers: { cookie } });
    expect(locked.status).toBe(204);
    expect(locked.headers.get('set-cookie')).toContain('Max-Age=0');

    expect(await (await call('/health')).json()).toMatchObject({ locked: true });
    expect((await call('/ui/api/status', { headers: { cookie } })).status).toBe(401);
  });

  test('logout ends only the calling session and leaves the vault unlocked', async () => {
    const mine = await cookieFrom(await unlock());
    const other = await cookieFrom(await unlock(PASSPHRASE, '198.51.100.9'));
    const out = await call('/ui/api/logout', { method: 'POST', headers: { cookie: mine } });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    expect((await call('/ui/api/profiles', { headers: { cookie: mine } })).status).toBe(401);
    expect((await call('/ui/api/profiles', { headers: { cookie: other } })).status).toBe(200);
    expect(await (await call('/health')).json()).toMatchObject({ locked: false });
    expect((await call('/ui/api/logout', { method: 'POST' })).status).toBe(401);
  });

  test('a session on a vault locked another way gets 503, not data', async () => {
    const cookie = await cookieFrom(await unlock());
    lockVault(); // e.g. a future Lock from a different client
    const res = await call('/ui/api/profiles', { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('read-only can be toggled from the UI', async () => {
    const cookie = await cookieFrom(await unlock());
    const off = await call('/ui/api/profiles/telegram/bot', {
      method: 'PATCH', headers: { cookie }, body: JSON.stringify({ readOnly: false }),
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ service: 'telegram', name: 'bot', readOnly: false });
    const list = await (await call('/ui/api/profiles', { headers: { cookie } })).json();
    expect(list.profiles[0].readOnly).toBe(false);

    const bad = await call('/ui/api/profiles/telegram/bot', {
      method: 'PATCH', headers: { cookie }, body: JSON.stringify({ readOnly: 'yes' }),
    });
    expect(bad.status).toBe(400);
    const missing = await call('/ui/api/profiles/telegram/nope', {
      method: 'PATCH', headers: { cookie }, body: JSON.stringify({ readOnly: true }),
    });
    expect(missing.status).toBe(404);
  });

  test('delete removes the profile and its credentials', async () => {
    const cookie = await cookieFrom(await unlock());
    const gone = await call('/ui/api/profiles/telegram/bot', { method: 'DELETE', headers: { cookie } });
    expect(gone.status).toBe(204);
    const list = await (await call('/ui/api/profiles', { headers: { cookie } })).json();
    expect(list.profiles).toEqual([{ service: 'slack', name: 'empty', readOnly: false }]);
    expect(await getCredentials('telegram', 'bot')).toBeNull();

    expect((await call('/ui/api/profiles/telegram/bot', { method: 'DELETE', headers: { cookie } })).status).toBe(404);
    expect((await call('/ui/api/profiles/notaservice/x', { method: 'DELETE', headers: { cookie } })).status).toBe(404);
  });

  test('mutations need a session too', async () => {
    expect((await call('/ui/api/profiles/telegram/bot', { method: 'DELETE' })).status).toBe(401);
    expect((await call('/ui/api/profiles/telegram/bot', { method: 'PATCH', body: '{}' })).status).toBe(401);
  });

  test('keys: create returns the token once, list hides hashes, rotate and revoke', async () => {
    const cookie = await cookieFrom(await unlock());
    const created = await call('/ui/api/keys', {
      method: 'POST', headers: { cookie },
      body: JSON.stringify({ name: 'agent', allowedProfiles: ['telegram/bot'], readOnly: true, url: 'https://hub.example.com' }),
    });
    expect(created.status).toBe(201);
    const { key, token } = await created.json();
    expect(token).toMatch(/^agio1\./);
    expect(key).not.toHaveProperty('secretHash');

    const list = await (await call('/ui/api/keys', { headers: { cookie } })).json();
    expect(list.keys).toEqual([key]);
    expect(JSON.stringify(list)).not.toContain('secretHash');

    const bad = await call('/ui/api/keys', {
      method: 'POST', headers: { cookie },
      body: JSON.stringify({ name: 'x', allowedProfiles: ['nope/nope'], readOnly: false, url: 'https://hub.example.com' }),
    });
    expect(bad.status).toBe(400);

    const patched = await call(`/ui/api/keys/${key.id}`, {
      method: 'PATCH', headers: { cookie }, body: JSON.stringify({ name: 'renamed', readOnly: false }),
    });
    expect(await patched.json()).toMatchObject({ id: key.id, name: 'renamed', readOnly: false });

    const rotated = await call(`/ui/api/keys/${key.id}/rotate`, {
      method: 'POST', headers: { cookie }, body: JSON.stringify({ url: 'https://hub.example.com' }),
    });
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).token).not.toBe(token);

    expect((await call(`/ui/api/keys/${key.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await call(`/ui/api/keys/${key.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(404);
    expect((await call('/ui/api/keys/nope/rotate', { method: 'POST', headers: { cookie }, body: '{"url":"https://h"}' })).status).toBe(404);
  });

  test('device login: start while locked, owner approves with a scope, poll gets the token once', async () => {
    const start = await call('/v1/device', { method: 'POST', body: JSON.stringify({ name: 'laptop' }), ip: '203.0.113.20' });
    expect(start.status).toBe(201);
    const { userCode, deviceCode, interval } = await start.json();
    expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(interval).toBe(3);

    const poll = () => call('/v1/device/token', { method: 'POST', body: JSON.stringify({ deviceCode }), ip: '203.0.113.20' });
    expect(await (await poll()).json()).toMatchObject({ status: 'pending' });

    // The owner needs a session and an unlocked vault; the code is accepted however it was typed.
    expect((await call(`/ui/api/authorize/${userCode}`)).status).toBe(401);
    const cookie = await cookieFrom(await unlock());
    const typed = userCode.toLowerCase().replace('-', ' ');
    const shown = await call(`/ui/api/authorize/${encodeURIComponent(typed)}`, { headers: { cookie } });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ userCode, name: 'laptop' });
    expect((await call('/ui/api/authorize/ZZZZ-ZZZZ', { headers: { cookie } })).status).toBe(404);

    const approved = await call(`/ui/api/authorize/${userCode}`, {
      method: 'POST', headers: { cookie },
      body: JSON.stringify({ approve: true, name: 'laptop', allowedProfiles: ['telegram/bot'], readOnly: true, url: 'https://hub.example.com' }),
    });
    expect(approved.status).toBe(201);
    const { key } = await approved.json();
    expect(key).toMatchObject({ name: 'laptop', allowedProfiles: ['telegram/bot'], readOnly: true });

    const got = await (await poll()).json();
    expect(got.status).toBe('approved');
    expect(got.token).toMatch(/^agio1\./);
    expect(got.key.id).toBe(key.id);
    // Handed out once: the request is gone, and so is the owner's page for it.
    expect((await poll()).status).toBe(404);
    expect((await call(`/ui/api/authorize/${userCode}`, { headers: { cookie } })).status).toBe(404);

    const list = await (await call('/ui/api/keys', { headers: { cookie } })).json();
    expect(list.keys.map((k: { id: string }) => k.id)).toContain(key.id);
  });

  test('device login: deny, bad input, and the address limit', async () => {
    const start = await (await call('/v1/device', { method: 'POST', body: JSON.stringify({ name: 'ci' }), ip: '203.0.113.21' })).json();
    const cookie = await cookieFrom(await unlock());
    const denied = await call(`/ui/api/authorize/${start.userCode}`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ approve: false }) });
    expect(denied.status).toBe(204);
    const poll = await call('/v1/device/token', { method: 'POST', body: JSON.stringify({ deviceCode: start.deviceCode }), ip: '203.0.113.21' });
    expect(await poll.json()).toEqual({ status: 'denied' });
    expect((await call('/ui/api/keys', { headers: { cookie } })).status).toBe(200);
    expect((await (await call('/ui/api/keys', { headers: { cookie } })).json()).keys).toEqual([]);

    expect((await call('/v1/device', { method: 'POST', body: JSON.stringify({}), ip: '203.0.113.21' })).status).toBe(400);
    expect((await call('/v1/device/token', { method: 'POST', body: JSON.stringify({ deviceCode: 'nope' }), ip: '203.0.113.21' })).status).toBe(404);
    for (let i = 0; i < 40; i++) await call('/v1/device/token', { method: 'POST', body: '{}', ip: '203.0.113.22' });
    expect((await call('/v1/device/token', { method: 'POST', body: '{}', ip: '203.0.113.22' })).status).toBe(429);
  });

  test('key routes need a session', async () => {
    expect((await call('/ui/api/keys')).status).toBe(401);
    expect((await call('/ui/api/keys', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  test('unknown paths are 404 JSON', async () => {
    expect((await call('/nope')).status).toBe(404);
    const cookie = await cookieFrom(await unlock());
    expect((await call('/ui/api/nope', { headers: { cookie } })).status).toBe(404);
  });
});
