import { expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import type { SecretsCredentials } from '../../../src/plugins/secrets/types';

const vault = withTempVault('agentio-secrets-json-', () => ({ config: { profiles: {} } as never }));

const cli = (args: string[], lines: string[] = []) => runCli(['secrets', 'profile', 'add', ...args], vault.env(), lines);

test('--input with a value is refused as unknown: nothing to ask, nothing saved', async () => {
  const res = await cli(['--json', '--input', '-'], ['{"x":"1"}']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'Unknown setup value "x"' });
  expect(res.events.some((e) => e.event === 'added')).toBe(false);
  expect(await getCredentials('secrets', 'default')).toBeNull();
}, 30_000);

test('--describe --json: no inputs, no sign-in; nothing saved', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'needs', service: 'secrets', inputs: [], auth: 'none' }]);
  expect(await getCredentials('secrets', 'default')).toBeNull();
}, 30_000);

test('--json adds an empty profile, a second run gets the next free name', async () => {
  const first = await cli(['--json']);
  expect(first.exitCode).toBe(0);
  expect(first.events).toEqual([{ v: 1, event: 'added', service: 'secrets', profile: 'default', readOnly: false }]);
  expect(await getCredentials<SecretsCredentials>('secrets', 'default')).toEqual({ values: {} });

  // chooseProfileName: "default" is taken, so base "default" gets the suffix 2.
  const second = await cli(['--json']);
  expect(second.exitCode).toBe(0);
  expect(second.events).toEqual([{ v: 1, event: 'added', service: 'secrets', profile: 'default-2', readOnly: false }]);
}, 60_000);

test('--json --read-only marks the profile read-only', async () => {
  const res = await cli(['--json', '--read-only']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'added', service: 'secrets', profile: 'default', readOnly: true }]);
}, 30_000);
