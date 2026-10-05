import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { withTempVault } from '../helpers/vault';
import { runCli } from '../helpers/cli';
import { FakeKite } from '../plugins/kite/fake-kite';
import { getCredentials } from '../../src/auth/token-store';
import { createApiKey } from '../../src/auth/api-keys';
import { createRequestHandler } from '../../src/daemon/api';
import { clearVaultCache, loadVault, lockVault, unlockVault } from '../../src/vault/vault';
import type { KiteCredentials } from '../../src/plugins/kite/types';

/**
 * `profile reauth --json`: the CLI in its own process, against a fake Kite. The seeded Kite profile
 * is read-only and points at the fake, so a re-sign-in reaches nothing else.
 */

const PASSPHRASE = 'reauth-pw-12345';
const OLD_EMAIL = 'old@example.com';
const OLD_TOKEN = 'old-token';
let fake: FakeKite;

const vault = withTempVault('agentio-reauth-json-', () => {
  fake = new FakeKite();
  return {
    passphrase: PASSPHRASE,
    config: {
      profiles: {
        kite: [{ name: OLD_EMAIL, readOnly: true }],
        gcal: [{ name: 'cal@example.com' }],
        dropbox: [{ name: 'box' }],
      },
    } as never,
    credentials: {
      kite: { [OLD_EMAIL]: { baseUrl: fake.url, token: OLD_TOKEN, email: OLD_EMAIL, expiresAt: '2026-01-01T00:00:00Z' } },
      gcal: { 'cal@example.com': { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', email: 'cal@example.com' } },
      dropbox: { box: { appKey: 'my-app-key', accessToken: 'a', refreshToken: 'r', expiryDate: 0 } },
    } as never,
  };
});
afterEach(() => fake.stop());

const cli = (args: string[], lines: string[] = [], env: Record<string, string> = {}) =>
  runCli(args, { ...vault.env(), ...env }, lines);

async function storedKite(profile = OLD_EMAIL): Promise<KiteCredentials | null> {
  clearVaultCache();
  return getCredentials<KiteCredentials>('kite', profile);
}

describe('profile reauth --json, local vault', () => {
  test('the code, the address to open, then reauthed; the profile keeps its name and read-only flag', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const started = Date.now();
    const res = await cli(['profile', 'reauth', 'kite', OLD_EMAIL, '--json']);
    // It ends by itself once saved; the helper's kill is not what stops it.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(res.exitCode).toBe(0);
    const device = [...fake.devices.values()][0];
    const page = `${fake.url}/auth/device?code=${device.userCode}`;
    expect(res.events).toEqual([
      { v: 1, event: 'code', userCode: device.userCode, verificationUrl: page, expiresIn: 600 },
      { v: 1, event: 'open', url: page },
      { v: 1, event: 'reauthed', service: 'kite', profile: OLD_EMAIL },
    ]);
    const saved = await storedKite();
    expect(saved?.token).not.toBe(OLD_TOKEN);
    expect(fake.tokens.get(saved!.token)).toBe(OLD_EMAIL);
    expect(saved?.email).toBe(OLD_EMAIL);
    expect(saved?.baseUrl).toBe(fake.url);
    // Secrets never reach stdout.
    expect(res.stdout).not.toContain(saved!.token);
    expect(res.stdout).not.toContain(device.deviceCode);
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);

  test('signing in as another account stores that account under the same profile name', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: 'new@example.com' };
    const res = await cli(['profile', 'reauth', 'kite', OLD_EMAIL, '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.events.at(-1)).toEqual({ v: 1, event: 'reauthed', service: 'kite', profile: OLD_EMAIL });
    const saved = await storedKite();
    expect(saved?.email).toBe('new@example.com');
    expect(fake.tokens.get(saved!.token)).toBe('new@example.com');
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
    expect(await storedKite('new@example.com')).toBeNull();
  }, 30_000);

  test('a service without declared needs is refused, and its credentials are left alone', async () => {
    const res = await cli(['profile', 'reauth', 'gcal', 'cal@example.com', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events).toEqual([{
      v: 1, event: 'error', code: 'INVALID_PARAMS',
      message: 'gcal cannot be signed in again with --json yet',
      suggestion: 'Run: agentio profile reauth gcal cal@example.com',
    }]);
    clearVaultCache();
    expect(await getCredentials('gcal', 'cal@example.com')).toMatchObject({ access_token: 'a', refresh_token: 'r' });
  }, 30_000);

  test('a profile that does not exist is PROFILE_NOT_FOUND, before anything is opened or requested', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const res = await cli(['profile', 'reauth', 'kite', 'nobody@example.com', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'PROFILE_NOT_FOUND' })]);
    expect(fake.requests()).toEqual([]);
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);

  test('a refused sign-in saves nothing and ends with an error event', async () => {
    fake.nextDeviceApproval = undefined;
    const run = cli(['profile', 'reauth', 'kite', OLD_EMAIL, '--json']);
    for (let i = 0; i < 200 && fake.devices.size === 0; i++) await Bun.sleep(25);
    fake.deny([...fake.devices.values()][0].userCode);
    const res = await run;
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'AUTH_FAILED' });
    expect(res.events.some((e) => e.event === 'reauthed')).toBe(false);
    expect((await storedKite())?.token).toBe(OLD_TOKEN);
  }, 30_000);

  test('Dropbox asks for the code through stdin; a closed stdin ends the run without reaching Dropbox', async () => {
    const res = await cli(['profile', 'reauth', 'dropbox', 'box', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events[0].event).toBe('open');
    const open = new URL(res.events[0].url);
    expect(open.searchParams.get('client_id')).toBe('my-app-key');
    expect(res.events[1]).toEqual({ v: 1, event: 'ask', id: 'code', label: 'Code Dropbox shows after you allow access', kind: 'secret' });
    expect(res.events[2]).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Code Dropbox shows after you allow access"' });
    expect(res.events).toHaveLength(3);
  }, 30_000);

  test('without --json the terminal flow still signs in again and saves', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    // Only bun on PATH: no browser opener can be found, so nothing opens.
    const res = await cli(['profile', 'reauth', 'kite', OLD_EMAIL], [], { PATH: dirname(process.execPath) });
    expect(res.exitCode).toBe(0);
    expect(res.events).toEqual([]);
    expect(res.stderr).toContain('To sign in to Kite, open:');
    const saved = await storedKite();
    expect(saved?.token).not.toBe(OLD_TOKEN);
    expect(fake.tokens.get(saved!.token)).toBe(OLD_EMAIL);
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);
});

describe('profile reauth --json against a hub', () => {
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
    PATH: process.env.PATH ?? '',
    HOME: clientHome,
    AGENTIO_HOME: join(clientHome, '.config', 'agentio'),
    AGENTIO_TOKEN: token,
  });

  test('a key without the managing right gets the same refusal as profile add, before anything opens', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const token = (await createApiKey({ name: 'agent', allowedProfiles: [`kite/${OLD_EMAIL}`] }, hubUrl)).token;
    const reauth = await remote(['profile', 'reauth', 'kite', OLD_EMAIL, '--json'], token);
    const add = await remote(['kite', 'profile', 'add', '--json'], token);
    expect(reauth.exitCode).not.toBe(0);
    expect(reauth.events).toHaveLength(1);
    expect(reauth.events[0]).toMatchObject({ event: 'error', code: 'PERMISSION_DENIED' });
    expect(reauth.events).toEqual(add.events);
    expect(fake.requests()).toEqual([]);
    expect((await loadVault()).credentials.kite?.[OLD_EMAIL]).toMatchObject({ token: OLD_TOKEN });
  }, 30_000);

  test('a managing key signs in again on the hub: same name, same read-only flag, new credentials', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: 'new@example.com' };
    const token = (await createApiKey({ name: 'manager', allowedProfiles: [`kite/${OLD_EMAIL}`], canManageProfiles: true }, hubUrl)).token;
    const res = await remote(['profile', 'reauth', 'kite', OLD_EMAIL, '--json'], token);
    expect(res.exitCode).toBe(0);
    expect(res.events.map((e) => e.event)).toEqual(['code', 'open', 'reauthed']);
    expect(res.events.at(-1)).toEqual({ v: 1, event: 'reauthed', service: 'kite', profile: OLD_EMAIL });
    const saved = await getCredentials<KiteCredentials>('kite', OLD_EMAIL);
    expect(saved?.email).toBe('new@example.com');
    expect(fake.tokens.get(saved!.token)).toBe('new@example.com');
    expect(res.stdout).not.toContain(saved!.token);
    expect((await loadVault()).config.profiles.kite).toEqual([{ name: OLD_EMAIL, readOnly: true }]);
  }, 30_000);

  test('a managing key cannot sign in again a profile outside its allow-list', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: OLD_EMAIL };
    const token = (await createApiKey({ name: 'narrow', allowedProfiles: ['gcal/cal@example.com'], canManageProfiles: true }, hubUrl)).token;
    const res = await remote(['profile', 'reauth', 'kite', OLD_EMAIL, '--json'], token);
    expect(res.exitCode).not.toBe(0);
    expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'PROFILE_NOT_FOUND' })]);
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

    test('profile reauth --json reaches the sign-in instead of stopping at the dead refresh', async () => {
      const res = await remote(['profile', 'reauth', 'dropbox', 'box', '--json'], await manager());
      expect(res.exitCode).not.toBe(0);
      expect(res.events.map((e) => e.event)).toEqual(['open', 'ask', 'error']);
      expect(new URL(res.events[0].url).searchParams.get('client_id')).toBe('my-app-key');
      expect(res.events[2]).toMatchObject({ code: 'INVALID_PARAMS', message: 'No answer for "Code Dropbox shows after you allow access"' });
      expect(refreshCalls).toBe(0);
      expect((await loadVault()).credentials.dropbox?.box).toMatchObject({ refreshToken: 'r', accessToken: 'a' });
    }, 30_000);
  });

  test('a credentials read the hub refuses for another reason is an error event, before anything opens', async () => {
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
      const res = await remote(['profile', 'reauth', 'dropbox', 'box', '--json'], token);
      expect(res.exitCode).not.toBe(0);
      expect(res.events).toEqual([expect.objectContaining({
        event: 'error', code: 'NOT_FOUND', message: expect.stringContaining('Plugin "dropbox" is not installed on this hub'),
      })]);
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
