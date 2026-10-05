import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { kiteProfileAdd, reauthenticateKite, type KiteSetupDeps } from '../../../src/plugins/kite/commands';
import { fakeSetupContext } from '../../helpers/setup-context';
import { addProfileWithSetup } from '../../../src/plugins/profile-host';
import { getCredentials } from '../../../src/auth/token-store';
import { loadVault } from '../../../src/vault/vault';
import { configDir } from '../../../src/vault/pointer';
import { CliError } from '../../../src/utils/errors';
import type { KiteCredentials } from '../../../src/plugins/kite/types';
import { FakeKite, caught } from './fake-kite';

// The installed agentio's folder, as it is before any test runs.
const REAL_CONFIG = join(process.env.HOME || homedir(), '.config', 'agentio');
function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  return readdirSync(dir).sort().map((name) => {
    const s = statSync(join(dir, name));
    return `${name}:${s.size}:${s.mtimeMs}`;
  }).join('|');
}
const REAL_BEFORE = snapshot(REAL_CONFIG);

const EMAIL = 'me@example.com';
const OLD: KiteCredentials = { baseUrl: 'http://127.0.0.1:1', token: 'old-token', email: 'old@example.com', expiresAt: '2026-01-01T00:00:00Z' };

withTempVault('agentio-kite-setup-', () => ({
  config: { profiles: { kite: ['existing'] } } as never,
  credentials: { kite: { existing: OLD } } as never,
}));

let fake: FakeKite;
let events: string[];
let stdout: string[];
let fetched: string[];
let opened: string[];
const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalWrite = process.stdout.write.bind(process.stdout);

const deps = (): KiteSetupDeps => ({
  sleep: async () => {},
  now: () => 0,
});

beforeEach(() => {
  fake = new FakeKite();
  events = [];
  stdout = [];
  fetched = [];
  opened = [];
  // Only the fake may be reached; anything else fails without leaving the machine.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (!url.startsWith(fake.url)) throw new TypeError(`blocked: ${url}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  console.error = (...args: unknown[]) => { events.push(`err:${args.join(' ')}`); };
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  process.stdout.write = originalWrite;
  fake.stop();
});

afterAll(() => {
  expect(snapshot(REAL_CONFIG)).toBe(REAL_BEFORE);
});

test('setup returns normalised credentials, named after the email', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const result = await kiteProfileAdd({ url: `${fake.url}/` }, fakeSetupContext({}, opened), deps());
  expect(result.suggestedProfileName).toBe(EMAIL);
  expect(result.credentials).toEqual({ baseUrl: fake.url, token: expect.stringMatching(/^cli_/), email: EMAIL, expiresAt: '2026-04-01T00:00:00Z' });
  expect(fake.tokens.get(result.credentials.token)).toBe(EMAIL);
  expect(fetched.every((u) => u.startsWith(fake.url))).toBe(true);
});

test('a URL without a scheme gets https', async () => {
  const e = await caught(kiteProfileAdd({ url: 'kite.example' }, fakeSetupContext({}, opened), deps()));
  expect(e.code).toBe('NETWORK_ERROR');
  expect(fetched).toEqual(['https://kite.example/api/auth/device']);
});

test('ftp and garbage are refused before any request', async () => {
  for (const url of ['ftp://kite.example', '   ', 'http://', 'https://u:p@kite.example']) {
    expect((await caught(kiteProfileAdd({ url }, fakeSetupContext({}, opened), deps()))).code).toBe('INVALID_PARAMS');
  }
  expect(fetched).toEqual([]);
});

test('without --url the URL is asked for, as a url', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const ctx = fakeSetupContext({ url: fake.url }, opened);
  await kiteProfileAdd({}, ctx, deps());
  expect(ctx.asked).toEqual([{ id: 'url', label: 'Kite server URL', kind: 'url', help: 'For example https://kite.example.com' }]);
});

test('the browser opens only after the code is printed', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const ctx = fakeSetupContext({}, events);
  ctx.log = (...parts) => { events.push(`err:${parts.join(' ')}`); };
  await kiteProfileAdd({ url: fake.url }, ctx, deps());
  const printed = events.findIndex((e) => e.startsWith('err:') && e.includes('/auth/device?code='));
  const open = events.findIndex((e) => e.startsWith(`${fake.url}/auth/device?code=`));
  expect(printed).toBeGreaterThanOrEqual(0);
  expect(open).toBeGreaterThan(printed);
  expect(stdout).toEqual([]);
});

test('--no-browser prints the link and never opens a browser', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const ctx = fakeSetupContext({}, opened);
  ctx.log = (...parts) => { events.push(`err:${parts.join(' ')}`); };
  await kiteProfileAdd({ url: fake.url, browser: false }, ctx, deps());
  expect(opened).toEqual([]);
  expect(events.some((e) => e.includes(`${fake.url}/auth/device?code=`))).toBe(true);
});

test('--json puts only the code event on stdout', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  await kiteProfileAdd({ url: fake.url, json: true }, fakeSetupContext({}, opened), deps());
  expect(stdout.length).toBe(1);
  const event = JSON.parse(stdout[0]);
  const device = [...fake.devices.values()][0];
  expect(event).toEqual({ v: 1, event: 'code', userCode: device.userCode, verificationUrl: `${fake.url}/auth/device?code=${device.userCode}`, expiresIn: 600 });
});

test('a failing /api/auth/me after approval saves no profile', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  fake.after((r) => r.path === '/api/auth/device/token', () => fake.failNext(500, { error: { code: 'internal_error', message: 'x' } }));
  const before = await loadVault();
  const e = await caught(addProfileWithSetup('kite', (o) => kiteProfileAdd(o as never, fakeSetupContext({}, opened), deps()), { url: fake.url } as never));
  expect(e.code).toBe('API_ERROR');
  const after = await loadVault();
  expect(after.config.profiles.kite).toEqual(before.config.profiles.kite);
  expect(Object.keys(after.credentials.kite ?? {})).toEqual(['existing']);
});

test('a successful add lands in the temp vault only', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  await addProfileWithSetup('kite', (o) => kiteProfileAdd(o as never, fakeSetupContext({}, opened), deps()), { url: fake.url } as never);
  expect(configDir().startsWith(process.env.HOME!)).toBe(true);
  const saved = await getCredentials<KiteCredentials>('kite', EMAIL);
  expect(saved?.email).toBe(EMAIL);
  expect(saved?.baseUrl).toBe(fake.url);
  expect(fetched.every((u) => u.startsWith(fake.url))).toBe(true);
});

describe('reauthenticate', () => {
  test('keeps the URL, replaces the token and refreshes the email', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: 'new@example.com' };
    const next = await reauthenticateKite({ ...OLD, baseUrl: fake.url }, 'existing', fakeSetupContext({}, opened), deps());
    expect(next.baseUrl).toBe(fake.url);
    expect(next.token).not.toBe(OLD.token);
    expect(next.email).toBe('new@example.com');
    // The address to approve went through the host's context, not a browser of its own.
    expect(opened).toEqual([`${fake.url}/auth/device?code=${[...fake.devices.values()][0].userCode}`]);
    expect(fetched.every((u) => u.startsWith(fake.url))).toBe(true);
  });

  test('a failed sign-in leaves the stored credentials untouched', async () => {
    const existing = await getCredentials<KiteCredentials>('kite', 'existing');
    fake.after((r) => r.path === '/api/auth/device', () => {
      for (const d of fake.devices.values()) fake.deny(d.userCode);
    });
    // The host writes only what the hook returns, so a throw must leave the vault alone.
    const e = await caught(reauthenticateKite({ ...existing!, baseUrl: fake.url }, 'existing', fakeSetupContext({}, opened), deps()));
    expect(e.code).toBe('AUTH_FAILED');
    expect(await getCredentials<KiteCredentials>('kite', 'existing')).toEqual(OLD);
  });

  test('credentials without a URL are a CONFIG_ERROR, with no request', async () => {
    expect((await caught(reauthenticateKite(null, 'x', fakeSetupContext({}, opened), deps()))).code).toBe('CONFIG_ERROR');
    expect(fetched).toEqual([]);
  });
});
