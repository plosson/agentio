import { expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import type { ChatGptCredentials } from '../../../src/plugins/chatgpt/types';

const SECRET = 'sk-SECRET';
const vault = withTempVault('agentio-chatgpt-json-', () => ({ config: { profiles: {} } as never }));

// The API key method makes no request and never runs codex, so nothing is stubbed.
const cli = (args: string[], lines: string[] = []) => runCli(['chatgpt', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: a method and a model, with a browser sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toHaveLength(1);
  const [needs] = res.events as Array<{ auth: string; inputs: Array<{ id: string }> }>;
  expect(needs).toMatchObject({ v: 1, event: 'needs', service: 'chatgpt', auth: 'browser' });
  expect(needs.inputs.map((i) => i.id)).toEqual(['method', 'model']);
}, 30_000);

test('the API key method: one ask for the key, then added; the key never printed', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ method: 'apiKey', model: '' }), JSON.stringify({ id: 'apiKey', value: SECRET })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([
    expect.objectContaining({ event: 'ask', id: 'apiKey', kind: 'secret' }),
    { v: 1, event: 'added', service: 'chatgpt', profile: 'default', readOnly: false },
  ]);
  expect(res.stdout).not.toContain(SECRET);
  expect(await getCredentials<ChatGptCredentials>('chatgpt', 'default')).toEqual({ kind: 'apiKey', apiKey: SECRET });
}, 30_000);

test('an unknown method: one INVALID_PARAMS error and no profile', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ method: 'nope' })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS' })]);
  expect(await getCredentials('chatgpt', 'default')).toBeNull();
}, 30_000);
