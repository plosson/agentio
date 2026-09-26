import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { lockVault, unlockVault } from '../../src/vault/vault';

// Only the Atlassian exchange is replaced; bun's module mocks are process-wide.
const jiraRefresh = mock(async (refreshToken: string) => ({ accessToken: 'jira-new', refreshToken: `${refreshToken}-rotated`, expiresIn: 3600 }));
const realJira = await import('../../src/plugins/jira/oauth');
mock.module('../../src/plugins/jira/oauth', () => ({ ...realJira, refreshJiraToken: jiraRefresh }));

const { createRequestHandler } = await import('../../src/daemon/api');
const { createApiKey, listApiKeys } = await import('../../src/auth/api-keys');
const { v1AuthLimiter, v1KeyLimiter, V1_REQUESTS_PER_MINUTE } = await import('../../src/daemon/routes-v1');

// Tests inject the client IP via X-Forwarded-For; trust it here as a fronting proxy would.
process.env.AGENTIO_TRUSTED_IP_HEADER = 'x-forwarded-for';

const PASSPHRASE = 'hub-passphrase-123';
const HOUR = 60 * 60 * 1000;
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
const write = (method: 'PUT' | 'PATCH') => (path: string, token: string, body: unknown) =>
  call(path, { method, token, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = write('PUT');
const patch = write('PATCH');
const del = (path: string, token: string) => call(path, { method: 'DELETE', token });

withTempVault('agentio-v1-test-', () => ({
    passphrase: PASSPHRASE,
    config: {
      profiles: {
        discourse: [{ name: 'bot' }],
        gmail: [{ name: 'work', readOnly: true }],
        jira: [{ name: 'fresh' }, { name: 'stale' }],
        revolut: [{ name: 'biz' }],
        slack: [{ name: 'empty' }],
      },
    },
    credentials: {
      discourse: { bot: { botToken: 'bot-secret', channelId: '1' } },
      gmail: { work: { access_token: 'g-at', refresh_token: 'g-rt', expiry_date: Date.now() + HOUR, token_type: 'Bearer' } },
      jira: {
        fresh: { accessToken: 'j-at', refreshToken: 'j-rt', expiryDate: Date.now() + HOUR, cloudId: 'c', siteUrl: 's' },
        // Fresh for the CLI's 5-minute buffer, stale for the hub's 10-minute one.
        stale: { accessToken: 'j-old', refreshToken: 'j-rt2', expiryDate: Date.now() + 7 * 60_000, cloudId: 'c', siteUrl: 's' },
      },
      revolut: { biz: { accessToken: 'r-at', refreshToken: 'r-rt', privateKey: 'PEM', clientId: 'id', redirectUri: 'u', environment: 'sandbox', expiryDate: Date.now() + HOUR } },
    },
}));

beforeEach(async () => {
  scopedToken = (await createApiKey({ name: 'scoped', allowedProfiles: ['discourse/bot', 'jira/fresh'], readOnly: false }, 'https://hub')).token;
  allToken = (await createApiKey({ name: 'all', allowedProfiles: '*', readOnly: true }, 'https://hub')).token;
  // Daemon posture: locked until unlocked, then stays so.
  delete process.env.AGENTIO_PASSPHRASE;
  lockVault();
  await unlockVault(PASSPHRASE);
  jiraRefresh.mockClear();
  v1AuthLimiter.reset();
  v1KeyLimiter.reset();
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

  test('a key is capped per minute, independently of other keys', async () => {
    for (let i = 0; i < V1_REQUESTS_PER_MINUTE; i++) expect((await call('/v1/profiles', { token: scopedToken })).status).toBe(200);
    const over = await call('/v1/profiles', { token: scopedToken });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: 'RATE_LIMITED', error: expect.stringContaining(String(V1_REQUESTS_PER_MINUTE)) });
    expect((await call('/v1/profiles', { token: allToken })).status).toBe(200);
  });

  test('profiles lists only what the key may use, with the effective read-only flag', async () => {
    const scoped = await (await call('/v1/profiles', { token: scopedToken })).json();
    expect(scoped.canManageProfiles).toBe(false);
    expect(scoped.profiles).toEqual([
      { service: 'jira', name: 'fresh', readOnly: false, hasCredentials: true },
      { service: 'discourse', name: 'bot', readOnly: false, hasCredentials: true },
    ]);
    const all = await (await call('/v1/profiles', { token: allToken })).json();
    expect(all.profiles).toHaveLength(6);
    // The key is read-only, so every profile is, including ones that are not themselves.
    expect(all.profiles.every((p: { readOnly: boolean }) => p.readOnly)).toBe(true);
    expect(all.profiles.find((p: { service: string }) => p.service === 'slack').hasCredentials).toBe(false);
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
    const tg = await (await creds('/v1/profiles/discourse/bot/credentials', scopedToken)).json();
    expect(tg).toEqual({
      service: 'discourse', name: 'bot', readOnly: false, refreshed: false,
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
    const res = await creds('/v1/profiles/jira/stale/credentials', allToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refreshed).toBe(true);
    expect(body.credentials.accessToken).toBe('jira-new');
    expect(body.credentials).not.toHaveProperty('refreshToken');
    expect(jiraRefresh).toHaveBeenCalledTimes(1);

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
    await creds('/v1/profiles/discourse/bot/credentials', scopedToken);
    await new Promise((r) => setTimeout(r, 20));
    const keys = await listApiKeys();
    expect(keys.find((k) => k.name === 'scoped')!.lastUsedAt).toBeDefined();
    expect(keys.find((k) => k.name === 'all')!.lastUsedAt).toBeUndefined();
  });
});

describe('managing profiles over /v1', () => {
  let addToken = '';
  beforeEach(async () => {
    addToken = (await createApiKey({ name: 'adder', allowedProfiles: ['discourse/bot'], canManageProfiles: true }, 'https://hub')).token;
  });

  test('PUT adds a free name and the key can use it at once', async () => {
    const res = await put('/v1/profiles/discourse/newbot', addToken, { readOnly: true, credentials: { botToken: 'n', channelId: '2' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ service: 'discourse', name: 'newbot', readOnly: true });

    const listed = await (await call('/v1/profiles', { token: addToken })).json();
    expect(listed.canManageProfiles).toBe(true);
    expect(listed.profiles).toContainEqual({ service: 'discourse', name: 'newbot', readOnly: true, hasCredentials: true });
    const got = await (await creds('/v1/profiles/discourse/newbot/credentials', addToken)).json();
    expect(got.credentials).toEqual({ botToken: 'n', channelId: '2' });
  });

  test('PUT replaces a profile the key reaches, which is how an agent repairs its own credentials', async () => {
    const res = await put('/v1/profiles/discourse/bot', addToken, { credentials: { botToken: 'refreshed', channelId: '1' } });
    expect(res.status).toBe(201);
    const got = await (await creds('/v1/profiles/discourse/bot/credentials', addToken)).json();
    expect(got.credentials).toEqual({ botToken: 'refreshed', channelId: '1' });
  });

  test('PATCH renames, carrying the credentials and the key\'s own scope along', async () => {
    const res = await patch('/v1/profiles/discourse/bot', addToken, { name: 'renamed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: 'discourse', name: 'renamed' });

    expect((await creds('/v1/profiles/discourse/bot/credentials', addToken)).status).toBe(404);
    const got = await (await creds('/v1/profiles/discourse/renamed/credentials', addToken)).json();
    expect(got.credentials).toEqual({ botToken: 'bot-secret', channelId: '1' });
    expect((await listApiKeys()).find((k) => k.name === 'adder')!.allowedProfiles).toEqual(['discourse/renamed']);
  });

  test('DELETE removes the profile and drops it from the scope', async () => {
    expect((await del('/v1/profiles/discourse/bot', addToken)).status).toBe(204);
    expect((await call('/v1/profiles/discourse/bot', { token: allToken })).status).toBe(404);
    expect((await listApiKeys()).find((k) => k.name === 'adder')!.allowedProfiles).toEqual([]);
  });

  test('every write is refused without the right', async () => {
    for (const res of [
      await put('/v1/profiles/discourse/newbot', scopedToken, { credentials: { botToken: 'n' } }),
      await patch('/v1/profiles/discourse/bot', scopedToken, { name: 'x' }),
      await del('/v1/profiles/discourse/bot', scopedToken),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect((await call('/v1/profiles/discourse/newbot', { token: allToken })).status).toBe(404);
  });

  test('a profile outside the key\'s list is 403 on every verb, as it is on a read, and nothing is written', async () => {
    for (const res of [
      await put('/v1/profiles/gmail/work', addToken, { credentials: { access_token: 'hijack' } }),
      await patch('/v1/profiles/gmail/work', addToken, { name: 'stolen' }),
      await del('/v1/profiles/gmail/work', addToken),
      await creds('/v1/profiles/gmail/work/credentials', addToken),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    const kept = await (await creds('/v1/profiles/gmail/work/credentials', allToken)).json();
    expect(kept.credentials).toMatchObject({ access_token: 'g-at' });
  });

  test('a name nothing holds is 404 on rename and delete, and free to create', async () => {
    expect((await patch('/v1/profiles/discourse/ghost', addToken, { name: 'x' })).status).toBe(404);
    expect((await del('/v1/profiles/discourse/ghost', addToken)).status).toBe(404);
    expect((await put('/v1/profiles/discourse/ghost', addToken, { credentials: { botToken: 'g' } })).status).toBe(201);
  });

  test('a replace keeps the read-only flag the owner set unless the write states one', async () => {
    const wide = (await createApiKey({ name: 'wide2', allowedProfiles: '*', canManageProfiles: true }, 'https://hub')).token;
    // gmail/work is read-only in the fixture; a repair sends credentials only.
    expect((await put('/v1/profiles/gmail/work', wide, { credentials: { access_token: 'fresh' } })).status).toBe(201);
    const listed = await (await call('/v1/profiles', { token: wide })).json();
    expect(listed.profiles.find((p: { name: string }) => p.name === 'work').readOnly).toBe(true);
  });

  test('a rename onto a name taken in the same service is 400, and changes nothing', async () => {
    const wide = (await createApiKey({ name: 'wide', allowedProfiles: '*', canManageProfiles: true }, 'https://hub')).token;
    const res = await patch('/v1/profiles/jira/fresh', wide, { name: 'stale' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PARAMS', error: expect.stringContaining('already exists') });
    expect((await call('/v1/profiles/jira/fresh', { token: wide })).status).toBe(200);

    // Names are per service, so the same word in another service is free.
    expect((await patch('/v1/profiles/discourse/bot', wide, { name: 'stale' })).status).toBe(200);
  });

  test.each([{}, { credentials: null }, { credentials: [] }, { credentials: {} }, { credentials: { a: 1 }, readOnly: 'yes' }])(
    'PUT rejects body %j', async (body) => {
      const res = await put('/v1/profiles/discourse/x', addToken, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_PARAMS' });
    },
  );

  test.each([{}, { name: 4 }, { name: 'a/b' }, { name: '' }])('PATCH rejects body %j', async (body) => {
    expect((await patch('/v1/profiles/discourse/bot', addToken, body)).status).toBe(400);
  });

  test('a name with "/" is 400, and the credentials path is not a write target', async () => {
    expect((await put('/v1/profiles/discourse/a%2Fb', addToken, { credentials: { a: 1 } })).status).toBe(400);
    expect((await put('/v1/profiles/discourse/bot/credentials', addToken, { credentials: { a: 1 } })).status).toBe(404);
    expect((await del('/v1/profiles/discourse/bot/credentials', addToken)).status).toBe(404);
  });
});
