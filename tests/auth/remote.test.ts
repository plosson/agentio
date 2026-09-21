import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeToken } from '../../src/auth/token';
import { clearRemoteToken, hub, isRemoteMode, remoteDeleteProfile, remoteProfiles, remoteSaveProfile, remoteToken, resetRemoteCache, saveRemoteToken, tokenFilePath } from '../../src/auth/remote';
import { CliError } from '../../src/utils/errors';
import { getCredentials, setCredentials } from '../../src/auth/token-store';
import { isProfileReadOnly, listProfileRefs, loadConfig, resolveProfile } from '../../src/config/config-manager';
import { enforceWriteAccess } from '../../src/utils/read-only';

/**
 * The client side of remote mode against a scripted hub. The real hub is
 * exercised in-process by routes-v1.test.ts and end to end, with the CLI as a
 * subprocess, by commands/remote-mode.test.ts; this file covers the mapping
 * from hub responses to what the local code sees.
 */

type Scripted = { status: number; body: unknown };
let script: Record<string, Scripted> = {};
let hits: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let url = '';
// Remote mode falls back to ~/.config/agentio/token, so the real HOME must stay out of reach.
let home = '';
let savedHome: string | undefined;

const PROFILES = [
  { service: 'gdrive', name: 'docs', readOnly: false, hasCredentials: true },
  { service: 'gmail', name: 'work', readOnly: true, hasCredentials: true },
  { service: 'gmail', name: 'home', readOnly: false, hasCredentials: false },
];

beforeAll(async () => {
  const { mkdtemp } = await import('fs/promises');
  const { tmpdir } = await import('os');
  savedHome = process.env.HOME;
  home = await mkdtemp(`${tmpdir()}/agentio-remote-test-`);
  process.env.HOME = home;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const key = `${req.method} ${new URL(req.url).pathname}`;
      hits.push(key);
      if (!req.headers.get('authorization')?.startsWith('Bearer agio1.')) {
        return new Response(JSON.stringify({ error: 'no bearer', code: 'AUTH_FAILED' }), { status: 401 });
      }
      const hit = script[key] ?? { status: 404, body: { error: 'unscripted', code: 'PROFILE_NOT_FOUND' } };
      return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  process.env.HOME = savedHome;
  const { rm } = await import('fs/promises');
  await rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  hits = [];
  script = { 'GET /v1/profiles': { status: 200, body: { profiles: PROFILES } } };
  process.env.AGENTIO_TOKEN = encodeToken({ url, kid: 'kid', secret: 'secret' });
  resetRemoteCache();
});

afterEach(() => {
  delete process.env.AGENTIO_TOKEN;
  resetRemoteCache();
});

describe('a hub that does not know the service', () => {
  test('explains the version mismatch instead of passing on a bare "Not found"', async () => {
    // A hub predating a service has no route for it, so its router falls
    // through to the generic 404. Relaying that verbatim told the user nothing
    // — not that remote mode was in play, nor which hub, nor what was wrong.
    script['PUT /v1/profiles/falco/acme'] = { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };

    const error = (await remoteSaveProfile('falco' as never, 'acme', { token: 'x' }, {}).catch((e) => e)) as CliError;

    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.message).toContain('does not know the service "falco"');
    expect(error.message).toContain(url);
    expect(error.suggestion).toContain('older agentio');
  });

  test('leaves a 404 on other methods alone, so a missing profile stays a missing profile', async () => {
    // remoteDeleteProfile reads a 404 as "already gone"; re-coding it would
    // turn an idempotent delete into a hard failure.
    script['DELETE /v1/profiles/gmail/gone'] = { status: 404, body: { error: 'Not found', code: 'PROFILE_NOT_FOUND' } };

    expect(await remoteDeleteProfile('gmail', 'gone')).toBe('absent');
  });

  test('keeps a real hub refusal on a PUT rather than blaming the hub version', async () => {
    script['PUT /v1/profiles/gmail/work'] = {
      status: 403,
      body: { error: 'this key may not manage profiles', code: 'PERMISSION_DENIED' },
    };

    const error = (await remoteSaveProfile('gmail', 'work', { token: 'x' }, {}).catch((e) => e)) as CliError;

    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.message).toContain('may not manage profiles');
  });
});

describe('remote mode', () => {
  test('falls back to the token file, and the env var wins over it', async () => {
    const { mkdtemp, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { statSync } = await import('fs');
    const home = await mkdtemp(`${tmpdir()}/agentio-token-test-`);
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    delete process.env.AGENTIO_TOKEN;
    resetRemoteCache();
    try {
      expect(isRemoteMode()).toBe(false);
      const fileToken = encodeToken({ url: 'https://file.example', kid: 'f', secret: 's' });
      const path = await saveRemoteToken(fileToken);
      expect(path).toBe(tokenFilePath());
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(isRemoteMode()).toBe(true);
      expect(remoteToken()).toBe(fileToken);
      expect(hub().url).toBe('https://file.example');

      process.env.AGENTIO_TOKEN = encodeToken({ url: 'https://env.example', kid: 'e', secret: 's' });
      resetRemoteCache();
      expect(hub().url).toBe('https://env.example');
      delete process.env.AGENTIO_TOKEN;
      resetRemoteCache();

      expect(await clearRemoteToken()).toBe(true);
      expect(await clearRemoteToken()).toBe(false);
      expect(isRemoteMode()).toBe(false);
    } finally {
      process.env.HOME = savedHome;
      resetRemoteCache();
      await rm(home, { recursive: true, force: true });
    }
  });

  test('is on exactly when AGENTIO_TOKEN is set', () => {
    expect(isRemoteMode()).toBe(true);
    delete process.env.AGENTIO_TOKEN;
    expect(isRemoteMode()).toBe(false);
  });

  test('profile reads come from the hub, once per process, and carry the effective read-only flag', async () => {
    expect(await listProfileRefs()).toEqual([
      { service: 'gdrive', name: 'docs' },
      { service: 'gmail', name: 'work', readOnly: true },
      { service: 'gmail', name: 'home' },
    ]);
    expect(await resolveProfile('gdrive')).toEqual({ profile: 'docs', readOnly: undefined });
    expect(await resolveProfile('gmail')).toEqual({ profile: null, error: 'multiple', names: ['work', 'home'] });
    expect(await resolveProfile('gmail', 'work')).toEqual({ profile: 'work', readOnly: true });
    expect(await resolveProfile('slack')).toEqual({ profile: null, error: 'none' });
    expect(await isProfileReadOnly('gmail', 'work')).toBe(true);
    await expect(enforceWriteAccess('gmail', 'work', 'send')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      suggestion: expect.stringContaining('vault hub'),
    });
    expect(hits.filter((h) => h.startsWith('GET /v1/profiles'))).toHaveLength(1);
  });

  test('credentials are one POST per profile; nothing stored is null, an unknown profile is not', async () => {
    script['POST /v1/profiles/gdrive/docs/credentials'] = { status: 200, body: { credentials: { accessToken: 'at' } } };
    script['POST /v1/profiles/gmail/home/credentials'] = { status: 404, body: { error: 'No credentials stored', code: 'NOT_FOUND' } };
    expect(await getCredentials<{ accessToken: string }>('gdrive', 'docs')).toEqual({ accessToken: 'at' });
    expect(await getCredentials('gmail', 'home')).toBeNull();
    await expect(getCredentials('slack', 'nope')).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });

  test('the hub\'s own code and suggestion survive the hop', async () => {
    script['POST /v1/profiles/gmail/work/credentials'] = { status: 400, body: { error: 'bad', code: 'INVALID_PARAMS', suggestion: 'fix it' } };
    await expect(getCredentials('gmail', 'work')).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'bad', suggestion: 'fix it' });
  });

  test.each([
    [401, { error: 'Invalid or missing token', code: 'AUTH_FAILED' }, 'AUTH_FAILED', /rejected this token/],
    [403, { error: 'This token is not allowed to use gmail/work', code: 'PERMISSION_DENIED' }, 'PERMISSION_DENIED', /not allowed/],
    [409, { error: 'Token refresh failed', code: 'TOKEN_EXPIRED' }, 'TOKEN_EXPIRED', /Re-authentication is needed on the vault host/],
    [429, { error: 'Too many attempts', code: 'RATE_LIMITED' }, 'RATE_LIMITED', /Too many/],
    [503, { error: 'Vault is locked on the hub', code: 'VAULT_LOCKED' }, 'CONFIG_ERROR', /locked on the hub/],
    [500, { error: 'boom' }, 'API_ERROR', /boom/],
    [502, {}, 'API_ERROR', /HTTP 502/],
  ])('hub status %i becomes %s', async (status, body, code, message) => {
    script['POST /v1/profiles/gmail/work/credentials'] = { status, body };
    await expect(getCredentials('gmail', 'work')).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  });

  test('an unreachable hub is NETWORK_ERROR naming the hub', async () => {
    process.env.AGENTIO_TOKEN = encodeToken({ url: 'http://127.0.0.1:1', kid: 'kid', secret: 's' });
    resetRemoteCache();
    await expect(remoteProfiles()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('127.0.0.1:1') });
  });

  test('a malformed token fails before any request', async () => {
    process.env.AGENTIO_TOKEN = 'not-a-token';
    resetRemoteCache();
    await expect(getCredentials('gdrive', 'docs')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(hits).toHaveLength(0);
  });

  test('writes and raw config reads are refused with a pointer to the hub', async () => {
    await expect(setCredentials('gdrive', 'docs', {})).rejects.toMatchObject({
      code: 'CONFIG_ERROR', suggestion: expect.stringContaining(url),
    });
    await expect(loadConfig()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(hits).toHaveLength(0);
  });
});
