import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import type { DiscourseCredentials } from '../../../src/plugins/discourse/types';
import { FakeDiscourse, KEY, USER } from './fake-discourse';

const vault = withTempVault('agentio-discourse-json-', () => ({ config: { profiles: {} } as never }));
let fake: FakeDiscourse;
beforeEach(() => { fake = new FakeDiscourse(); });
afterEach(() => fake.stop());

const cli = (args: string[], lines: string[] = []) => runCli(['discourse', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: url, key, username; no sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'discourse', auth: 'none',
    inputs: [
      { id: 'url', label: 'Forum URL', kind: 'url', help: 'For example https://meta.discourse.org' },
      { id: 'apiKey', label: 'API key', kind: 'secret', help: 'Create one in your forum\'s admin, API keys (/admin/api/keys)' },
      { id: 'username', label: 'Username', kind: 'text', help: 'The user the API key acts as' },
    ],
  }]);
  expect(fake.log).toEqual([]);
}, 30_000);

test('ftp://x is refused before any request', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: 'ftp://x', apiKey: KEY, username: USER })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  expect(fake.log).toEqual([]);
}, 30_000);

test('unknown ids and wrong types are refused before any request', async () => {
  for (const line of [`{"url":"${fake.url}","apiKey":42,"username":"${USER}"}`, `{"url":"${fake.url}","apiKey":"${KEY}","username":"${USER}","x":"y"}`, 'not json']) {
    const res = await cli(['--json', '--input', '-'], [line]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  }
  expect(fake.log).toEqual([]);
}, 60_000);

test('stdin closed after the url: No answer for "API key", the key is never requested', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: fake.url })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "API key"' });
  expect(fake.log).toEqual([]);
}, 30_000);

test('a bad key: AUTH_FAILED, no profile, key not printed', async () => {
  const secret = 'SECRET-BAD-KEY';
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: fake.url, apiKey: secret, username: USER })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'AUTH_FAILED', message: expect.stringMatching(/^Invalid API key or username/) });
  expect(res.stdout).not.toContain(secret);
  expect(await getCredentials('discourse', USER)).toBeNull();
}, 30_000);

test('happy path: added, baseUrl without a trailing slash, key never printed', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: `${fake.url}/`, apiKey: KEY, username: USER })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'added', service: 'discourse', profile: USER, readOnly: false }]);
  expect(res.stdout).not.toContain(KEY);
  expect(await getCredentials<DiscourseCredentials>('discourse', USER)).toEqual({ baseUrl: fake.url, apiKey: KEY, username: USER });
}, 30_000);
