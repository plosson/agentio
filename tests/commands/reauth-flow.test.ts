import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { withTempVault } from '../helpers/vault';
import { runCli, spawnCli } from '../helpers/cli';
import { FakeKite } from '../plugins/kite/fake-kite';
import { getCredentials } from '../../src/auth/token-store';
import { deleteProfile } from '../../src/config/profile-store';
import { createApiKey } from '../../src/auth/api-keys';
import { createRequestHandler } from '../../src/daemon/api';
import { clearVaultCache, loadVault, lockVault, unlockVault } from '../../src/vault/vault';
import type { KiteCredentials } from '../../src/plugins/kite/types';
import type { RevolutCredentials } from '../../src/plugins/revolut/types';

/**
 * `profile reauth` in a terminal: the CLI in its own process, against a fake Kite. The seeded Kite
 * profile is read-only and points at the fake, so a re-sign-in reaches nothing else. Only bun is on
 * PATH: no browser opener can be found, so nothing opens, and the address to open is on stderr.
 */

const PASSPHRASE = 'reauth-pw-12345';
const OLD_EMAIL = 'old@example.com';
const OLD_TOKEN = 'old-token';
let fake: FakeKite;
// Revolut signs in again with its private key, which a hub never hands out.
const REVOLUT: RevolutCredentials = {
  environment: 'sandbox', clientId: 'cid', privateKey: 'pem', redirectUri: 'https://example.com/cb',
  accessToken: 'a', refreshToken: 'r', expiryDate: 0,
};

const vault = withTempVault('agentio-reauth-flow-', () => {
  fake = new FakeKite();
  return {
    passphrase: PASSPHRASE,
    config: {
      profiles: {
        kite: [{ name: OLD_EMAIL, readOnly: true }],
        gcal: [{ name: 'cal@example.com' }],
        revolut: [{ name: 'biz' }],
        dropbox: [{ name: 'box' }],
      },
    } as never,
    credentials: {
      kite: { [OLD_EMAIL]: { baseUrl: fake.url, token: OLD_TOKEN, email: OLD_EMAIL, expiresAt: '2026-01-01T00:00:00Z' } },
      gcal: { 'cal@example.com': { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', email: 'cal@example.com' } },
      revolut: { biz: REVOLUT },
      dropbox: { box: { appKey: 'my-app-key', accessToken: 'a', refreshToken: 'r', expiryDate: 0 } },
    } as never,
  };
});
afterEach(() => fake.stop());

const TERMINAL = { PATH: dirname(process.execPath) };
const cli = (args: string[]) => runCli(args, { ...vault.env(), ...TERMINAL });

/** Start a reauth, delete the profile once the code is out and before approval, then approve. */
async function deletedDuringSignIn(run: () => Promise<Awaited<ReturnType<typeof runCli>>>) {
  fake.nextDeviceApproval = undefined;
  const pending = run();
  for (let i = 0; i < 400 && fake.devices.size === 0; i++) await Bun.sleep(25);
  const device = [...fake.devices.values()][0];
  expect(await deleteProfile('kite', OLD_EMAIL)).toBe(true);
  fake.approve(device.userCode, OLD_EMAIL);
  return pending;
}

const GONE = `Error [PROFILE_NOT_FOUND]: Profile "${OLD_EMAIL}" no longer exists for kite
Suggestion: Add it again with: agentio kite profile add`;

async function expectKiteGone(): Promise<void> {
  clearVaultCache();
  const after = await loadVault();
  expect(after.config.profiles.kite ?? []).toEqual([]);
  expect(after.credentials.kite?.[OLD_EMAIL]).toBeUndefined();
}

async function storedKite(profile = OLD_EMAIL): Promise<KiteCredentials | null> {
  clearVaultCache();
  return getCredentials<KiteCredentials>('kite', profile);
}

describe('profile reauth, local vault', () => {
  test('signs in again and saves: the profile keeps its name and read-only flag, no secret is printed', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const started = Date.now();
    const res = await cli(['profile', 'reauth', 'kite', OLD_EMAIL]);
    // It ends by itself once saved; the helper's kill is not what stops it.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(res.exitCode).toBe(0);
    const device = [...fake.devices.values()][0];
    expect(res.stderr).toContain(`To sign in to Kite, open:\n  ${fake.url}/auth/device?code=${device.userCode}`);
    expect(res.events).toEqual([]);
    const saved = await storedKite();
    expect(saved?.token).not.toBe(OLD_TOKEN);
    expect(fake.tokens.get(saved!.token)).toBe(OLD_EMAIL);
    expect(saved?.email).toBe(OLD_EMAIL);
    expect(saved?.baseUrl).toBe(fake.url);
    for (const secret of [saved!.token, device.deviceCode]) {
      expect(res.stdout).not.toContain(secret);
      expect(res.stderr).not.toContain(secret);
    }
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);

  test('signing in as another account stores that account under the same profile name', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: 'new@example.com' };
    const res = await cli(['profile', 'reauth', 'kite', OLD_EMAIL]);
    expect(res.exitCode).toBe(0);
    const saved = await storedKite();
    expect(saved?.email).toBe('new@example.com');
    expect(fake.tokens.get(saved!.token)).toBe('new@example.com');
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
    expect(await storedKite('new@example.com')).toBeNull();
  }, 30_000);

  test('a profile that does not exist is PROFILE_NOT_FOUND, before anything is opened or requested', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const res = await cli(['profile', 'reauth', 'kite', 'nobody@example.com']);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('Error [PROFILE_NOT_FOUND]');
    expect(res.stderr).not.toContain('To sign in to Kite');
    expect(fake.requests()).toEqual([]);
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);

  test('a profile deleted while the sign-in runs is not brought back: PROFILE_NOT_FOUND, nothing created', async () => {
    const res = await deletedDuringSignIn(() => cli(['profile', 'reauth', 'kite', OLD_EMAIL]));
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('To sign in to Kite, open:');
    expect(res.stderr).toContain(GONE);
    await expectKiteGone();
  }, 30_000);

  test('a refused sign-in saves nothing and ends with AUTH_FAILED', async () => {
    fake.nextDeviceApproval = undefined;
    const run = cli(['profile', 'reauth', 'kite', OLD_EMAIL]);
    for (let i = 0; i < 200 && fake.devices.size === 0; i++) await Bun.sleep(25);
    fake.deny([...fake.devices.values()][0].userCode);
    const res = await run;
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Error [AUTH_FAILED]');
    expect((await storedKite())?.token).toBe(OLD_TOKEN);
  }, 30_000);
});

describe('profile reauth against a hub', () => {
  let server: ReturnType<typeof Bun.serve>;
  let hubUrl = '';
  let clientHome = '';

  beforeEach(async () => {
    lockVault();
    await unlockVault(PASSPHRASE);
    const handle = createRequestHandler({ version: 'test' });
    server = Bun.serve({ port: 0, fetch: (req, srv) => handle(req, srv) });
    hubUrl = `http://127.0.0.1:${server.port}`;
    clientHome = await mkdtemp(join(tmpdir(), 'agentio-reauth-client-'));
  });

  afterEach(async () => {
    server.stop(true);
    await rm(clientHome, { recursive: true, force: true }).catch(() => {});
  });

  /** The CLI as an agent runs it: no vault of its own, only a key to the hub. */
  const remote = (args: string[], token: string) => runCli(args, {
    ...TERMINAL,
    HOME: clientHome,
    AGENTIO_HOME: join(clientHome, '.config', 'agentio'),
    AGENTIO_TOKEN: token,
  });

  test('a key without the managing right gets the same refusal as profile add, before anything opens', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const token = (await createApiKey({ name: 'agent', allowedProfiles: [`kite/${OLD_EMAIL}`] }, hubUrl)).token;
    const reauth = await remote(['profile', 'reauth', 'kite', OLD_EMAIL], token);
    const add = await remote(['kite', 'profile', 'add', '--url', fake.url], token);
    expect(reauth.exitCode).toBe(2);
    expect(reauth.stderr).toStartWith('Error [PERMISSION_DENIED]');
    expect(reauth.stderr).not.toContain('To sign in to Kite');
    expect([add.exitCode, add.stderr]).toEqual([reauth.exitCode, reauth.stderr]);
    expect(fake.requests()).toEqual([]);
    expect((await loadVault()).credentials.kite?.[OLD_EMAIL]).toMatchObject({ token: OLD_TOKEN });
  }, 30_000);

  test('a managing key signs in again on the hub: same name, same read-only flag, new credentials', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: 'new@example.com' };
    const token = (await createApiKey({ name: 'manager', allowedProfiles: [`kite/${OLD_EMAIL}`], canManageProfiles: true }, hubUrl)).token;
    const res = await remote(['profile', 'reauth', 'kite', OLD_EMAIL], token);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('To sign in to Kite, open:');
    const saved = await getCredentials<KiteCredentials>('kite', OLD_EMAIL);
    expect(saved?.email).toBe('new@example.com');
    expect(fake.tokens.get(saved!.token)).toBe('new@example.com');
    expect(res.stdout).not.toContain(saved!.token);
    expect(res.stderr).not.toContain(saved!.token);
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);

  test('a profile the owner deletes while a managing key signs in again is not brought back', async () => {
    const token = (await createApiKey({ name: 'manager', allowedProfiles: [`kite/${OLD_EMAIL}`], canManageProfiles: true }, hubUrl)).token;
    const res = await deletedDuringSignIn(() => remote(['profile', 'reauth', 'kite', OLD_EMAIL], token));
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('To sign in to Kite, open:');
    expect(res.stderr).toContain(GONE);
    await expectKiteGone();
  }, 30_000);

  test('the hub refuses a replace-only PUT for a missing profile, even for a key that may create it', async () => {
    const token = (await createApiKey({ name: 'wide', allowedProfiles: '*', canManageProfiles: true }, hubUrl)).token;
    const res = await fetch(`${hubUrl}/v1/profiles/kite/ghost`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials: { token: 't' }, replaceOnly: true }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PROFILE_NOT_FOUND', error: 'Profile "ghost" no longer exists for kite' });
    clearVaultCache();
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
    const bad = await fetch(`${hubUrl}/v1/profiles/kite/ghost`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials: { token: 't' }, replaceOnly: 'yes' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_PARAMS', error: 'replaceOnly must be true or false' });
  }, 30_000);

  test('Revolut, whose sign-in needs the private key a hub never hands out, is refused from a remote machine', async () => {
    const token = (await createApiKey({ name: 'manager', allowedProfiles: ['revolut/biz'], canManageProfiles: true }, hubUrl)).token;
    const res = await remote(['profile', 'reauth', 'revolut', 'biz'], token);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain(`Error [INVALID_PARAMS]: revolut cannot be signed in again from this machine yet
Suggestion: Run on the hub: agentio profile reauth revolut biz`);
    // Refused before the consent address is built.
    expect(res.stderr).not.toContain('Re-authenticating');
    clearVaultCache();
    expect((await loadVault()).credentials.revolut?.biz).toEqual({ ...REVOLUT });
  }, 30_000);

  test('Calendar, whose sign-in issues every secret afresh, is accepted from a remote machine and stops at the Google callback', async () => {
    const token = (await createApiKey({ name: 'manager', allowedProfiles: ['gcal/cal@example.com'], canManageProfiles: true }, hubUrl)).token;
    const run = spawnCli(['profile', 'reauth', 'gcal', 'cal@example.com'], { ...TERMINAL, HOME: clientHome, AGENTIO_HOME: join(clientHome, '.config', 'agentio'), AGENTIO_TOKEN: token });
    const url = new URL((await run.printed(/visit:\n(\S+)/))[1]);
    expect(url.host).toBe('accounts.google.com');
    expect((await fetch(`${url.searchParams.get('redirect_uri')}?error=access_denied`)).status).toBe(200);
    const res = await run.finish();
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/Error \[AUTH_FAILED\]: .*access_denied/);
    clearVaultCache();
    expect((await loadVault()).credentials.gcal?.['cal@example.com']).toMatchObject({ access_token: 'a', refresh_token: 'r' });
  }, 30_000);

  test('a managing key cannot sign in again a profile outside its allow-list', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const token = (await createApiKey({ name: 'narrow', allowedProfiles: ['gcal/cal@example.com'], canManageProfiles: true }, hubUrl)).token;
    const res = await remote(['profile', 'reauth', 'kite', OLD_EMAIL], token);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toStartWith('Error [PROFILE_NOT_FOUND]');
    expect(fake.requests()).toEqual([]);
    expect((await loadVault()).credentials.kite?.[OLD_EMAIL]).toMatchObject({ token: OLD_TOKEN });
  }, 30_000);

  describe('a profile whose refresh fails on the hub', () => {
    // Dropbox's stored token expired long ago (expiryDate 0), and Dropbox refuses the refresh.
    const originalFetch = globalThis.fetch;
    let refreshCalls = 0;
    beforeEach(() => {
      refreshCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(input instanceof Request ? input.url : input);
        if (target.startsWith('https://api.dropboxapi.com/')) {
          refreshCalls++;
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        if (!target.startsWith('http://127.0.0.1:')) throw new TypeError(`blocked: ${target}`);
        return originalFetch(input, init);
      }) as typeof fetch;
    });
    afterEach(() => { globalThis.fetch = originalFetch; });

    const manager = async () => (await createApiKey({ name: 'manager', allowedProfiles: ['dropbox/box'], canManageProfiles: true }, hubUrl)).token;
    const post = (path: string, token: string) =>
      fetch(`${hubUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

    test('the normal credentials read fails with TOKEN_EXPIRED: the case reauth must get past', async () => {
      const res = await post('/v1/profiles/dropbox/box/credentials', await manager());
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'TOKEN_EXPIRED' });
      expect(refreshCalls).toBe(1);
    });

    test('the stored read skips the refresh, strips the secrets, and keeps the allow-list', async () => {
      const token = await manager();
      const res = await post('/v1/profiles/dropbox/box/credentials?refresh=false', token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ service: 'dropbox', name: 'box', refreshed: false, credentials: { appKey: 'my-app-key', accessToken: 'a' } });
      expect(body.credentials).not.toHaveProperty('refreshToken');
      expect(refreshCalls).toBe(0);
      // Outside the key's list, the stored read is refused like the normal one.
      const other = await post('/v1/profiles/kite/old%40example.com/credentials?refresh=false', token);
      expect(other.status).toBe(403);
      const plain = await post('/v1/profiles/kite/old%40example.com/credentials', token);
      expect(plain.status).toBe(other.status);
    });

    test('profile reauth reaches the sign-in instead of stopping at the dead refresh', async () => {
      // stdin is closed, so the sign-in stops at the code question: nothing reaches Dropbox.
      const res = await remote(['profile', 'reauth', 'dropbox', 'box'], await manager());
      const address = res.stderr.match(/https:\/\/www\.dropbox\.com\/oauth2\/authorize\S+/)?.[0];
      expect(address).toBeDefined();
      expect(new URL(address!).searchParams.get('client_id')).toBe('my-app-key');
      expect(refreshCalls).toBe(0);
      expect((await loadVault()).credentials.dropbox?.box).toMatchObject({ refreshToken: 'r', accessToken: 'a' });
    }, 30_000);
  });

  test('a credentials read the hub refuses for another reason is an error, before anything opens', async () => {
    const paths: string[] = [];
    const broken = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname, search } = new URL(req.url);
        paths.push(`${req.method} ${pathname}${search}`);
        if (pathname === '/v1/profiles') {
          return Response.json({ profiles: [{ service: 'dropbox', name: 'box', readOnly: false, hasCredentials: true }], canManageProfiles: true });
        }
        return Response.json({ error: 'Plugin "dropbox" is not installed on this hub', code: 'NOT_FOUND' }, { status: 404 });
      },
    });
    try {
      const token = (await createApiKey({ name: 'k', allowedProfiles: '*', canManageProfiles: true }, `http://127.0.0.1:${broken.port}`)).token;
      const res = await remote(['profile', 'reauth', 'dropbox', 'box'], token);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toStartWith('Error [NOT_FOUND]: ');
      expect(res.stderr).toContain('Plugin "dropbox" is not installed on this hub');
      expect(res.stderr).not.toContain('dropbox.com/oauth2');
      // The reauth asked for the stored credentials, not a refresh.
      expect(paths).toContain('POST /v1/profiles/dropbox/box/credentials?refresh=false');
    } finally {
      broken.stop(true);
    }
  }, 30_000);

  test('the bulk agentio reauth stays owner-only on the hub host', async () => {
    const token = (await createApiKey({ name: 'manager', allowedProfiles: '*', canManageProfiles: true }, hubUrl)).token;
    const res = await remote(['reauth', '--all'], token);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('not available in remote mode');
  }, 30_000);
});
