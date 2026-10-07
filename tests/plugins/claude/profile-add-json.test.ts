import { expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import type { ClaudeCredentials } from '../../../src/plugins/claude/types';

const SECRET = 'sk-ant-oat01-SECRET';
const vault = withTempVault('agentio-claude-json-', () => ({ config: { profiles: {} } as never }));

// Setup makes no request and never runs claude, so nothing is stubbed.
const cli = (args: string[], lines: string[] = []) => runCli(['claude', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: a token and a model, no sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'claude', auth: 'none',
    inputs: [
      { id: 'token', label: 'Token or API key', kind: 'secret', help: 'Run `claude setup-token` for your subscription, or create an API key at console.anthropic.com' },
      { id: 'model', label: 'Default model', kind: 'text', required: false, help: 'Such as opus or sonnet; blank for Claude Code\'s default' },
    ],
  }]);
}, 30_000);

test('--json --input -: one added event, the token never printed, the kind and model saved', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ token: SECRET, model: 'opus' })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'added', service: 'claude', profile: 'default', readOnly: false }]);
  expect(res.stdout).not.toContain(SECRET);
  expect(await getCredentials<ClaudeCredentials>('claude', 'default')).toEqual({ token: SECRET, kind: 'oauth', model: 'opus' });
}, 30_000);

test('a token of another provider: one INVALID_PARAMS error and no profile', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ token: 'sk-proj-x', model: '' })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS' })]);
  expect(await getCredentials('claude', 'default')).toBeNull();
}, 30_000);

test('closed stdin with nothing given: the token is named, nothing hangs', async () => {
  const res = await cli(['--json']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([
    expect.objectContaining({ event: 'ask', id: 'token', kind: 'secret' }),
    expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Token or API key"' }),
  ]);
}, 30_000);
