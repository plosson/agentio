import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeToken } from './token';
import { isRemoteMode, remoteProfiles, resetRemoteCache } from './remote';
import { getCredentials, setCredentials } from './token-store';
import { isProfileReadOnly, listProfileRefs, loadConfig, resolveProfile } from '../config/config-manager';
import { enforceWriteAccess } from '../utils/read-only';

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

const PROFILES = [
  { service: 'gdrive', name: 'docs', readOnly: false },
  { service: 'gmail', name: 'work', readOnly: true },
  { service: 'gmail', name: 'home', readOnly: false },
];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const key = `${req.method} ${new URL(req.url).pathname}`;
      hits.push(key + (req.headers.get('authorization') ? '' : ' (no auth)'));
      const hit = script[key] ?? { status: 404, body: { error: 'unscripted', code: 'NOT_FOUND' } };
      return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

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

describe('remote mode', () => {
  test('is on exactly when AGENTIO_TOKEN is set', () => {
    expect(isRemoteMode()).toBe(true);
    delete process.env.AGENTIO_TOKEN;
    expect(isRemoteMode()).toBe(false);
  });

  test('profile reads come from the hub, once per process, and carry the effective read-only flag', async () => {
    // The flattener carries readOnly only when set, like the local one.
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
    expect(hits.some((h) => h.includes('no auth'))).toBe(false);
  });

  test('credentials are one POST per profile; missing ones are null', async () => {
    script['POST /v1/profiles/gdrive/docs/credentials'] = { status: 200, body: { credentials: { accessToken: 'at' } } };
    script['POST /v1/profiles/gmail/home/credentials'] = { status: 404, body: { error: 'No credentials stored', code: 'NOT_FOUND' } };
    expect(await getCredentials<{ accessToken: string }>('gdrive', 'docs')).toEqual({ accessToken: 'at' });
    expect(await getCredentials('gmail', 'home')).toBeNull();
  });

  test.each([
    [401, { error: 'Invalid or missing token' }, 'AUTH_FAILED', /rejected this token/],
    [403, { error: 'This token is not allowed to use gmail/work' }, 'PERMISSION_DENIED', /not allowed/],
    [409, { error: 'Token refresh failed' }, 'AUTH_FAILED', /Re-authentication is needed on the vault host/],
    [429, { error: 'Too many attempts' }, 'RATE_LIMITED', /Too many/],
    [503, { error: 'Vault is locked on the hub' }, 'CONFIG_ERROR', /locked on the hub/],
    [500, { error: 'boom' }, 'API_ERROR', /boom/],
  ])('hub status %i becomes %s', async (status, body, code, message) => {
    script['POST /v1/profiles/gmail/work/credentials'] = { status, body };
    await expect(getCredentials('gmail', 'work')).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  });

  test('an unreachable hub is NETWORK_ERROR naming the hub', async () => {
    process.env.AGENTIO_TOKEN = encodeToken({ url: 'http://127.0.0.1:1', kid: 'kid', secret: 's' });
    resetRemoteCache();
    await expect(remoteProfiles()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('127.0.0.1:1') });
    // A failed list is not cached.
    await expect(remoteProfiles()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
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
