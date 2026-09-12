import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedVault } from '../vault/test-helpers';
import { clearVaultCache, lockVault } from '../vault/vault';
import { clearPassphraseCache, resetPassphraseProvider } from '../vault/passphrase';
import { createRequestHandler, type PeerSource } from './api';
import { clearSessions } from './session';
import { unlockLimiter } from './routes-ui';

const PASSPHRASE = 'hub-passphrase-123';
let tempHome = '';
let savedHome = '';

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

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-api-test-'));
  process.env.HOME = tempHome;
  await seedVault({
    passphrase: PASSPHRASE,
    config: { profiles: { telegram: [{ name: 'bot', readOnly: true }] } },
    credentials: { telegram: { bot: { botToken: 't', channelId: '1' } } },
  });
  // seedVault leaves the vault unlocked through the env var; the daemon starts locked.
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  clearSessions();
  unlockLimiter.reset();
});

afterEach(async () => {
  process.env.HOME = savedHome;
  delete process.env.AGENTIO_PASSPHRASE;
  resetPassphraseProvider();
  clearPassphraseCache();
  clearVaultCache();
  clearSessions();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('daemon HTTP surface', () => {
  test('/health is public and reports the lock state', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', locked: true });
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
    expect(await (await call('/health')).json()).toMatchObject({ locked: false });

    const profiles = await call('/ui/api/profiles', { headers: { cookie } });
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toEqual({
      profiles: [{ service: 'telegram', name: 'bot', readOnly: true }],
    });

    const status = await call('/ui/api/status?test=false', { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      version: 'test',
      services: { telegram: [{ profile: 'bot', readOnly: true, status: 'skipped' }] },
    });
  });

  test('lock forgets the vault and every session', async () => {
    const cookie = await cookieFrom(await unlock());
    const locked = await call('/ui/api/lock', { method: 'POST', headers: { cookie } });
    expect(locked.status).toBe(204);
    expect(locked.headers.get('set-cookie')).toContain('Max-Age=0');

    expect(await (await call('/health')).json()).toMatchObject({ locked: true });
    expect((await call('/ui/api/status', { headers: { cookie } })).status).toBe(401);
  });

  test('a session on a vault locked another way gets 503, not data', async () => {
    const cookie = await cookieFrom(await unlock());
    lockVault(); // e.g. a future Lock from a different client
    const res = await call('/ui/api/profiles', { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('unknown paths are 404 JSON', async () => {
    expect((await call('/nope')).status).toBe(404);
    const cookie = await cookieFrom(await unlock());
    expect((await call('/ui/api/nope', { headers: { cookie } })).status).toBe(404);
  });
});
