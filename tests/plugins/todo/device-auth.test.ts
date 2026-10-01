import { afterEach, beforeEach, expect, test } from 'bun:test';
import { deviceLabel, todoDeviceLogin, type TodoDeviceCode } from '../../../src/plugins/todo/device-auth';
import { FakeTodo, caught } from './fake-todo';

const EMAIL = 'me@example.com';
let fake: FakeTodo;
let clock: number;
let sleeps: number[];
let codes: TodoDeviceCode[];

const sleep = async (ms: number) => { sleeps.push(ms); clock += ms; };
const now = () => clock;

function login(onCode: (c: TodoDeviceCode) => void = () => {}) {
  return todoDeviceLogin({
    baseUrl: fake.url,
    label: 'agentio on test',
    sleep,
    now,
    onCode: (c) => { codes.push(c); onCode(c); },
  });
}

const polls = () => fake.requests('POST', '/api/auth/device/token');

beforeEach(() => {
  fake = new FakeTodo();
  clock = 1_000_000;
  sleeps = [];
  codes = [];
});

afterEach(() => fake.stop());

test('pending then approved returns the token', async () => {
  fake.nextDeviceApproval = { afterPolls: 3, email: EMAIL };
  const result = await login();
  expect(polls().length).toBe(3);
  expect(fake.tokens.get(result.token)).toBe(EMAIL);
  expect(result.expiresAt).toBe('2026-04-01T00:00:00Z');
  const device = [...fake.devices.values()][0]!;
  expect(codes).toEqual([{
    userCode: device.userCode,
    verificationUrl: `${fake.url}/auth/device?code=${device.userCode}`,
    expiresInSeconds: 600,
  }]);
});

test('device-flow requests carry no Authorization header', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  await login();
  for (const r of fake.log) expect(r.headers.authorization).toBeUndefined();
  expect(fake.log[0]!.body).toEqual({ label: 'agentio on test' });
});

test('denied stops polling with AUTH_FAILED', async () => {
  const e = await caught(login((c) => fake.deny(c.userCode)));
  expect(e.code).toBe('AUTH_FAILED');
  expect(e.message).toContain('refused');
});

test('expired on the server (410) is AUTH_FAILED', async () => {
  const e = await caught(login((c) => fake.expire(c.userCode)));
  expect(e.code).toBe('AUTH_FAILED');
  expect(e.message).toContain('expired');
});

test('local deadline stops a forever-pending server', async () => {
  fake.expiresInSeconds = 10;
  const e = await caught(login());
  expect(e.code).toBe('AUTH_FAILED');
  expect(e.message).toContain('expired');
  expect(polls().length).toBeLessThanOrEqual(5);
});

test('verificationUrl on another origin is refused before onCode', async () => {
  fake.verificationOrigin = 'https://evil.example';
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const e = await caught(login());
  expect(e.code).toBe('API_ERROR');
  expect(e.message).toContain('another site');
  expect(codes).toEqual([]);
});

test('approved without a token is API_ERROR', async () => {
  const e = await caught(login(() => {
    fake.failNext(200, { state: 'approved' });
  }));
  expect(e.code).toBe('API_ERROR');
  expect(e.message).toContain('no token');
});

test('deviceLabel names the host, cut to 80 characters', () => {
  expect(deviceLabel('box')).toBe('agentio on box');
  expect(deviceLabel('x'.repeat(100)).length).toBe(80);
});
