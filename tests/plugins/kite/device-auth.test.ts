import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deviceLabel, kiteDeviceLogin, type KiteDeviceCode } from '../../../src/plugins/kite/device-auth';
import { CliError } from '../../../src/utils/errors';
import { FakeKite } from './fake-kite';

const EMAIL = 'me@example.com';
let fake: FakeKite;
let clock: number;
let sleeps: number[];
let codes: KiteDeviceCode[];

const sleep = async (ms: number) => { sleeps.push(ms); clock += ms; };
const now = () => clock;

function login(onCode: (c: KiteDeviceCode) => void = () => {}) {
  return kiteDeviceLogin({
    baseUrl: fake.url,
    label: 'agentio on test',
    sleep,
    now,
    onCode: (c) => { codes.push(c); onCode(c); },
  });
}

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected a CliError, got success');
}

const polls = () => fake.requests('POST', '/api/auth/device/token');

beforeEach(() => {
  fake = new FakeKite();
  clock = 1_000_000;
  sleeps = [];
  codes = [];
});

afterEach(() => fake.stop());

test('pending three times, then approved, returns the token', async () => {
  fake.nextDeviceApproval = { afterPolls: 4, email: EMAIL };
  const result = await login();
  expect(polls().length).toBe(4);
  expect(fake.tokens.get(result.token)).toBe(EMAIL);
  expect(result.expiresAt).toBe('2026-04-01T00:00:00Z');
  const device = [...fake.devices.values()][0];
  expect(codes).toEqual([{ userCode: device.userCode, verificationUrl: `${fake.url}/auth/device?code=${device.userCode}`, expiresInSeconds: 600 }]);
});

test('device-flow requests carry no Authorization header', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  await login();
  for (const r of fake.log) expect(r.headers.authorization).toBeUndefined();
  expect(fake.log[0].body).toEqual({ label: 'agentio on test' });
});

test('denied stops polling with AUTH_FAILED', async () => {
  const e = await caught(login((c) => fake.deny(c.userCode)));
  expect(e.code).toBe('AUTH_FAILED');
  expect(e.message).toContain('refused');
  expect(polls().length).toBe(1);
});

test('expired on the server (410) is AUTH_FAILED "expired"', async () => {
  const e = await caught(login((c) => fake.expire(c.userCode)));
  expect(e.code).toBe('AUTH_FAILED');
  expect(e.message).toContain('expired');
  expect(polls().length).toBe(1);
});

test('the local deadline stops a server that says pending forever', async () => {
  fake.expiresInSeconds = 10;
  const e = await caught(login());
  expect(e.code).toBe('AUTH_FAILED');
  expect(e.message).toContain('expired');
  // interval 2 s over 10 s: at most 5 polls, and never after the deadline.
  expect(polls().length).toBeLessThanOrEqual(5);
  expect(clock - 1_000_000).toBeLessThanOrEqual(12_000);
});

test('an already-claimed code (401 envelope) is AUTH_FAILED with no open-artifact', async () => {
  const e = await caught(login(() => fake.failNext(401, { error: { code: 'unauthenticated', message: 'Run open-artifact login.' } })));
  expect(e.code).toBe('AUTH_FAILED');
  expect(`${e.message} ${e.suggestion}`.toLowerCase()).not.toContain('artifact');
  expect(e.suggestion).toContain('agentio kite profile add');
});

test('a claimed code cannot be claimed twice', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  await login();
  const device = [...fake.devices.values()][0];
  const res = await fetch(`${fake.url}/api/auth/device/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: device.deviceCode }),
  });
  expect(res.status).toBe(401);
});

test('429 doubles the interval', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  await login(() => fake.rateLimitNext(1));
  expect(sleeps).toEqual([2000, 4000]);
});

test('two 503s, then pending, then approved succeeds', async () => {
  fake.nextDeviceApproval = { afterPolls: 2, email: EMAIL };
  const result = await login(() => {
    fake.failNext(503, { error: { code: 'internal_error', message: 'x' } });
    fake.failNext(503, { error: { code: 'internal_error', message: 'x' } });
  });
  expect(result.token).toBeTruthy();
  expect(polls().length).toBe(4);
});

test('four consecutive 5xx give API_ERROR', async () => {
  const e = await caught(login(() => { for (let i = 0; i < 4; i++) fake.failNextText(502, '<html>bad gateway</html>'); }));
  expect(e.code).toBe('API_ERROR');
  expect(polls().length).toBe(4);
});

test('four consecutive network failures give NETWORK_ERROR', async () => {
  const e = await caught(login(() => fake.stop()));
  expect(e.code).toBe('NETWORK_ERROR');
  expect(sleeps.length).toBe(4);
});

test('a start answer without the expected fields is API_ERROR', async () => {
  fake.failNext(200, {});
  expect((await caught(login())).code).toBe('API_ERROR');
  fake.failNext(200, { userCode: 'X', verificationUrl: `${fake.url}/auth/device`, expiresInSeconds: 60, intervalSeconds: 2 });
  expect((await caught(login())).code).toBe('API_ERROR');
  fake.failNextText(200, '<html>landing page</html>');
  expect((await caught(login())).code).toBe('API_ERROR');
  expect(codes).toEqual([]);
  expect(polls().length).toBe(0);
});

test('a start that fails maps through the client errors', async () => {
  fake.failNext(404, { error: { code: 'not_found', message: 'x' } });
  expect((await caught(login())).code).toBe('NOT_FOUND');
});

test('a verificationUrl on another origin is refused before onCode', async () => {
  fake.verificationOrigin = 'https://evil.example';
  const e = await caught(login());
  expect(e.code).toBe('API_ERROR');
  expect(e.message).toContain('evil.example');
  expect(codes).toEqual([]);
  expect(polls().length).toBe(0);
});

test('an interval of 0 is clamped to 1 s', async () => {
  fake.intervalSeconds = 0;
  fake.nextDeviceApproval = { afterPolls: 2, email: EMAIL };
  await login();
  expect(sleeps).toEqual([1000, 1000]);
});

test('approved without a token is API_ERROR, never an empty token', async () => {
  const e = await caught(login(() => fake.failNext(200, { state: 'approved' })));
  expect(e.code).toBe('API_ERROR');
  const e2 = await caught(login(() => fake.failNext(200, { state: 'approved', token: '' })));
  expect(e2.code).toBe('API_ERROR');
});

describe('deviceLabel', () => {
  test('names the host, cut to 80 characters', () => {
    expect(deviceLabel('box')).toBe('agentio on box');
    const long = deviceLabel('h'.repeat(200));
    expect(long.length).toBe(80);
    expect(long.startsWith('agentio on ')).toBe(true);
  });

  test('a long label is cut before it is sent', async () => {
    fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
    await kiteDeviceLogin({ baseUrl: fake.url, label: 'x'.repeat(200), sleep, now, onCode: () => {} });
    expect((fake.log[0].body as { label: string }).label.length).toBe(80);
  });
});
