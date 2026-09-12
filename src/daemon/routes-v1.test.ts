import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedVault } from '../vault/test-helpers';
import { clearVaultCache, lockVault, unlockVault } from '../vault/vault';
import { clearPassphraseCache, resetPassphraseProvider } from '../vault/passphrase';

// Only the Atlassian exchange is replaced; bun's module mocks are process-wide.
const jiraRefresh = mock(async (refreshToken: string) => ({ accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600 }));
const realJira = await import('../auth/jira-oauth');
mock.module('../auth/jira-oauth', () => ({ ...realJira, refreshJiraToken: jiraRefresh }));

const { createRequestHandler } = await import('./api');
const { createApiKey, listApiKeys } = await import('../auth/api-keys');
const { v1AuthLimiter } = await import('./routes-v1');
const { REFRESH_BUFFER_MS } = await import('../auth/refresh');

const PASSPHRASE = 'hub-passphrase-123';
const HOUR = 60 * 60 * 1000;
let tempHome = '';
let savedHome = '';
let scopedToken = '';
let allToken = '';

const handle = createRequestHandler({ version: 'test' });
const peer = { requestIP: () => ({ address: '10.0.0.5' }) };

function call(path: string, init: RequestInit & { token?: string; ip?: string } = {}): Promise<Response> {
  const { token, ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  if (ip) headers.set('x-forwarded-for', ip);
  return handle(new Request(`http://hub${path}`, { ...rest, headers }), peer);
}

const creds = (path: string, token: string) => call(path, { method: 'POST', token });

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-v1-test-'));
  process.env.HOME = tempHome;
  await seedVault({
    passphrase: PASSPHRASE,
    config: {
      profiles: {
        telegram: [{ name: 'bot' }],
        gmail: [{ name: 'work', readOnly: true }],
        jira: [{ name: 'fresh' }, { name: 'stale' }],
        revolut: [{ name: 'biz' }],
        slack: [{ name: 'empty' }],
      },
    },
    credentials: {
      telegram: { bot: { botToken: 'bot-secret', channelId: '1' } },
      gmail: { work: { access_token: 'g-at', refresh_token: 'g-rt', expiry_date: Date.now() + HOUR, token_type: 'Bearer' } },
      jira: {
        fresh: { accessToken: 'j-at', refreshToken: 'j-rt', expiryDate: Date.now() + HOUR, cloudId: 'c', siteUrl: 's' },
        stale: { accessToken: 'j-old', refreshToken: 'j-rt2', expiryDate: Date.now() + 60_000, cloudId: 'c', siteUrl: 's' },
      },
      revolut: { biz: { accessToken: 'r-at', refreshToken: 'r-rt', privateKey: 'PEM', clientId: 'id', redirectUri: 'u', environment: 'sandbox', expiryDate: Date.now() + HOUR } },
    },
  });
  scopedToken = (await createApiKey({ name: 'scoped', allowedProfiles: ['telegram/bot', 'jira/fresh'], readOnly: false }, 'https://hub')).token;
  allToken = (await createApiKey({ name: 'all', allowedProfiles: '*', readOnly: true }, 'https://hub')).token;
  // Daemon posture: locked until unlocked, then stays so.
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
  jiraRefresh.mockClear();
  v1AuthLimiter.reset();
});

afterEach(async () => {
  process.env.HOME = savedHome;
  delete process.env.AGENTIO_PASSPHRASE;
  resetPassphraseProvider();
  clearPassphraseCache();
  clearVaultCache();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('/v1 credential API', () => {
  test('a locked vault is 503 before any token is looked at', async () => {
    lockVault();
    const res = await call('/v1/profiles', { token: allToken });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('missing, malformed, and wrong tokens are 401, and repeats are rate limited per address', async () => {
    expect((await call('/v1/profiles')).status).toBe(401);
    expect((await call('/v1/profiles', { token: 'garbage' })).status).toBe(401);
    const parts = allToken.split('.');
    const wrongSecret = `${parts[0]}.${parts[1]}.${'x'.repeat(43)}`;
    for (let i = 0; i < 5; i++) expect((await call('/v1/profiles', { token: wrongSecret, ip: '203.0.113.9' })).status).toBe(401);
    expect((await call('/v1/profiles', { token: wrongSecret, ip: '203.0.113.9' })).status).toBe(429);
    // A valid token from the same address is never limited.
    expect((await call('/v1/profiles', { token: allToken, ip: '203.0.113.9' })).status).toBe(200);
  });

  test('profiles lists only what the key may use, with the effective read-only flag', async () => {
    const scoped = await (await call('/v1/profiles', { token: scopedToken })).json();
    expect(scoped.profiles).toEqual([
      { service: 'jira', name: 'fresh', readOnly: false },
      { service: 'telegram', name: 'bot', readOnly: false },
    ]);
    const all = await (await call('/v1/profiles', { token: allToken })).json();
    expect(all.profiles).toHaveLength(6);
    // The key is read-only, so every profile is, including ones that are not themselves.
    expect(all.profiles.every((p: { readOnly: boolean }) => p.readOnly)).toBe(true);
  });

  test('a profile outside the allow-list is 403, an unknown one 404', async () => {
    const denied = await creds('/v1/profiles/gmail/work/credentials', scopedToken);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await creds('/v1/profiles/gmail/nope/credentials', allToken)).status).toBe(404);
    expect((await creds('/v1/profiles/notaservice/x/credentials', allToken)).status).toBe(404);
    expect((await call('/v1/nope', { token: allToken })).status).toBe(404);
  });

  test('static credentials come back whole; refresh secrets are stripped from OAuth ones', async () => {
    const tg = await (await creds('/v1/profiles/telegram/bot/credentials', scopedToken)).json();
    expect(tg).toEqual({
      service: 'telegram', name: 'bot', readOnly: false, refreshed: false,
      credentials: { botToken: 'bot-secret', channelId: '1' },
    });

    const gmail = await (await creds('/v1/profiles/gmail/work/credentials', allToken)).json();
    expect(gmail.readOnly).toBe(true);
    expect(gmail.credentials).toMatchObject({ access_token: 'g-at' });
    expect(gmail.credentials).not.toHaveProperty('refresh_token');

    const rev = await (await creds('/v1/profiles/revolut/biz/credentials', allToken)).json();
    expect(rev.credentials).toMatchObject({ accessToken: 'r-at', clientId: 'id' });
    expect(rev.credentials).not.toHaveProperty('refreshToken');
    expect(rev.credentials).not.toHaveProperty('privateKey');
  });

  test('the hub refreshes with a wider buffer than the CLI, writes back, and says so', async () => {
    // Fresh for the CLI's 5-minute buffer, stale for the hub's 10-minute one.
    const res = await creds('/v1/profiles/jira/stale/credentials', allToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshed).toBe(true);
    expect(body.credentials.accessToken).toBe('jira-new');
    expect(body.credentials).not.toHaveProperty('refreshToken');
    expect(jiraRefresh).toHaveBeenCalledTimes(1);
    expect(60_000).toBeLessThan(REFRESH_BUFFER_MS); // sanity on the fixture

    const again = await (await creds('/v1/profiles/jira/stale/credentials', allToken)).json();
    expect(again.refreshed).toBe(false);
    expect(jiraRefresh).toHaveBeenCalledTimes(1);
  });

  test('a rejected refresh is 409 and the status route reports needs_reauth', async () => {
    jiraRefresh.mockImplementation(async () => { throw new Error('invalid_grant'); });
    const res = await creds('/v1/profiles/jira/stale/credentials', allToken);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(await (await call('/v1/profiles/jira/stale', { token: allToken })).json()).toEqual({ status: 'needs_reauth', readOnly: true });
    jiraRefresh.mockReset();
  });

  test('the status route distinguishes ok and no_creds', async () => {
    expect(await (await call('/v1/profiles/jira/fresh', { token: scopedToken })).json()).toEqual({ status: 'ok', readOnly: false });
    expect(await (await call('/v1/profiles/slack/empty', { token: allToken })).json()).toEqual({ status: 'no_creds', readOnly: true });
    expect((await call('/v1/profiles/slack/empty', { token: scopedToken })).status).toBe(403);
  });

  test('use is recorded on the key', async () => {
    await creds('/v1/profiles/telegram/bot/credentials', scopedToken);
    await new Promise((r) => setTimeout(r, 20));
    const keys = await listApiKeys();
    expect(keys.find((k) => k.name === 'scoped')!.lastUsedAt).toBeDefined();
    expect(keys.find((k) => k.name === 'all')!.lastUsedAt).toBeUndefined();
  });
});
