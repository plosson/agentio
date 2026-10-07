import { expect, test } from 'bun:test';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import { JEV_API_KEY_INPUT, JEV_MODEL_INPUT } from '../../../src/plugins/jev/setup-needs';
import type { JevCredentials } from '../../../src/plugins/jev/types';

const SECRET = 'SECRET-KEY-123';
const vault = withTempVault('agentio-jev-json-', () => ({ config: { profiles: {} } as never }));

// The subprocess answers api.typesafe.ai itself (stub-api-preload.ts): only SECRET is a good key.
const cli = (args: string[], lines: string[] = [], key = SECRET) =>
  runCli(['jev', 'profile', 'add', ...args], {
    ...vault.env(),
    BUN_OPTIONS: `--preload=${join(import.meta.dir, 'stub-api-preload.ts')}`,
    STUB_JEV_KEY: key,
  }, lines);

test('--describe --json: the API key and the model, no sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'jev', auth: 'none',
    inputs: [JEV_API_KEY_INPUT, JEV_MODEL_INPUT],
  }]);
}, 30_000);

test('bad --input is refused before any request', async () => {
  for (const line of ['{"apiKey":42}', '{"apiKey":"   "}', `{"apiKey":"${SECRET}","url":"x"}`, 'not json']) {
    const res = await cli(['--json', '--input', '-'], [line]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS' })]);
    expect(res.stdout).not.toContain(SECRET);
  }
}, 60_000);

test('closed stdin with nothing given: the key is named, nothing hangs', async () => {
  const res = await cli(['--json']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([
    expect.objectContaining({ event: 'ask', id: 'apiKey', kind: 'secret' }),
    expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "API key"' }),
  ]);
}, 30_000);

test('a wrong key: one AUTH_FAILED error, no profile, the key is never printed', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ apiKey: SECRET, model: 'jev-preview' })], 'another-key');
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'AUTH_FAILED' })]);
  expect(res.stdout).not.toContain(SECRET);
  expect(await getCredentials('jev', 'default')).toBeNull();
}, 30_000);

test('only the key given: the optional model is asked, a blank answer saves no model', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ apiKey: SECRET }), '{"id":"model","value":""}']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([
    expect.objectContaining({ event: 'ask', id: 'model' }),
    { v: 1, event: 'added', service: 'jev', profile: 'default', readOnly: false },
  ]);
  expect(res.stdout).not.toContain(SECRET);
  expect(await getCredentials<JevCredentials>('jev', 'default')).toEqual({ apiKey: SECRET });
}, 30_000);

test('key and model given: both saved, nothing asked', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ apiKey: SECRET, model: 'jev-preview' })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'added', service: 'jev', profile: 'default', readOnly: false }]);
  expect(res.stdout).not.toContain(SECRET);
  expect(await getCredentials<JevCredentials>('jev', 'default')).toEqual({ apiKey: SECRET, model: 'jev-preview' });
}, 30_000);

test('a flag wins over --input: the flag key is the one checked', async () => {
  const res = await cli(['--api-key', SECRET, '--model', 'jev-preview', '--json', '--input', '-'], [JSON.stringify({ apiKey: 'from-input' })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'added' })]);
  expect(await getCredentials<JevCredentials>('jev', 'default')).toEqual({ apiKey: SECRET, model: 'jev-preview' });
}, 30_000);
