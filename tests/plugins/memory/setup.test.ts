import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { memoryProfileAdd, suggestedName } from '../../../src/plugins/memory/commands';
import { addProfileWithSetup } from '../../../src/plugins/profile-host';
import { getCredentials } from '../../../src/auth/token-store';
import type { MemoryCredentials } from '../../../src/plugins/memory/types';
import { caught, FakeGraphiti, TOKEN } from './fake-graphiti';

withTempVault('agentio-memory-setup-', () => ({ config: { profiles: {} } as never }));

let fake: FakeGraphiti;
let fetched: string[];
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const noPrompt = () => fakeSetupContext({});

beforeEach(() => {
  fake = new FakeGraphiti();
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (!url.startsWith(fake.url)) throw new TypeError(`blocked: ${url}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  console.log = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  fake.stop();
});

test('setup checks the server with the token and returns normalised credentials', async () => {
  const result = await memoryProfileAdd({ url: `${fake.url}//`, token: ` ${TOKEN} `, group: 'famille' }, noPrompt());
  expect(result.credentials).toEqual({ baseUrl: fake.url, token: TOKEN, defaultGroup: 'famille' });
  expect(fake.log.map((r) => r.path)).toEqual(['/healthcheck', '/episodes/famille']);
  expect(fake.log.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
});

test('a wrong token stops setup; the token is never in the error', async () => {
  const err = await caught(memoryProfileAdd({ url: fake.url, token: 'SECRET-TOKEN-XYZ' }, noPrompt()));
  expect(err.code).toBe('AUTH_FAILED');
  expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain('SECRET-TOKEN-XYZ');
});

test('bad URL, empty token or bad group are refused before any request', async () => {
  for (const url of ['ftp://x', '  ', 'https://u:p@host']) {
    expect((await caught(memoryProfileAdd({ url, token: TOKEN }, noPrompt()))).code).toBe('INVALID_PARAMS');
  }
  expect((await caught(memoryProfileAdd({ url: fake.url, token: '  ' }, noPrompt()))).code).toBe('INVALID_PARAMS');
  expect((await caught(memoryProfileAdd({ url: fake.url, token: TOKEN, group: 'a b' }, noPrompt()))).code).toBe('INVALID_PARAMS');
  expect(fetched).toEqual([]);
});

test('with --url given, only the token is asked for, hidden, and no group', async () => {
  const context = fakeSetupContext({ 'Bearer token': TOKEN });
  const result = await memoryProfileAdd({ url: fake.url }, context);
  expect(context.asked.map((s) => s.label)).toEqual(['Bearer token']);
  expect(context.asked[0].kind).toBe('secret');
  expect(result.credentials).toEqual({ baseUrl: fake.url, token: TOKEN });
});

test('a fully interactive setup asks URL, token and an optional default group', async () => {
  const context = fakeSetupContext({ 'Graphiti server URL': fake.url, 'Bearer token': TOKEN, 'Default group': 'societes' });
  const result = await memoryProfileAdd({}, context);
  expect(context.asked.map((s) => s.label)).toEqual(['Graphiti server URL', 'Bearer token', 'Default group']);
  expect(result.credentials.defaultGroup).toBe('societes');
});

test('the profile is saved in the vault under the host name', async () => {
  await addProfileWithSetup('memory', (o) => memoryProfileAdd({ ...o, url: fake.url, token: TOKEN }, noPrompt()), {});
  expect(await getCredentials<MemoryCredentials>('memory', '127.0.0.1')).toEqual({ baseUrl: fake.url, token: TOKEN });
});

test('suggestedName uses the first host label', () => {
  expect(suggestedName('https://memory.example.com')).toBe('memory');
  expect(suggestedName('http://127.0.0.1:8000')).toBe('127.0.0.1');
});
