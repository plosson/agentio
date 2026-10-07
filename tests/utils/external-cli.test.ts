import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { CLAUDE_CLI, findCli, runExternalCli, withTempDir } from '../../src/utils/external-cli';
import { CliError } from '../../src/utils/errors';
import { installFakeCli, type FakeCli } from '../helpers/fake-cli';

let fake: FakeCli;
beforeEach(async () => { fake = await installFakeCli('claude'); fake.respond({ stdout: 'out' }); });
afterEach(async () => { await fake.restore(); });

const run = (env: Record<string, string> = {}, extra: Partial<Parameters<typeof runExternalCli>[1]> = {}) =>
  withTempDir('agentio-test-', (cwd) => runExternalCli(CLAUDE_CLI, { args: ['-p'], input: 'hi', cwd, unset: ['ANTHROPIC_API_KEY'], env, ...extra }));

test('a missing CLI gives an error a model can act on', async () => {
  process.env.PATH = '/nonexistent';
  const err = (() => { try { findCli(CLAUDE_CLI); } catch (e) { return e as CliError; } })()!;
  expect(err.code).toBe('CONFIG_ERROR');
  expect(err.message).toContain('claude CLI');
  expect(err.suggestion).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  expect(err.suggestion).toContain('claude --version');
  expect(err.suggestion).toContain('run the same agentio command again');
});

test('the input goes on stdin, intact, however large and whatever its characters', async () => {
  const input = `héllo 👋 "quotes" $HOME \`tick\`\n`.repeat(50_000);
  await withTempDir('agentio-test-', (cwd) => runExternalCli(CLAUDE_CLI, { args: [], input, cwd, unset: [], env: {} }));
  expect((await fake.lastCall()).stdin).toBe(input);
});

test('named variables are removed before the given ones are added', async () => {
  process.env.ANTHROPIC_API_KEY = 'stray-key';
  await run({ CLAUDE_CODE_OAUTH_TOKEN: 'profile-token' });
  const call = await fake.lastCall();
  expect(call.env.ANTHROPIC_API_KEY).toBeNull();
  expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('profile-token');
});

test('the CLI starts in an empty directory that is gone afterwards, also after a failure', async () => {
  fake.respond({ exit: 3, stderr: 'boom' });
  const result = await run();
  const call = await fake.lastCall();
  expect(result).toEqual({ exitCode: 3, stdout: '', stderr: 'boom' });
  expect(call.filesAtStart).toEqual([]);
  expect(existsSync(call.cwd)).toBe(false);
});

test('runs in parallel get separate directories', async () => {
  const dirs = await Promise.all([1, 2, 3].map(() => withTempDir('agentio-test-', async (cwd) => cwd)));
  expect(new Set(dirs).size).toBe(3);
});

test('a run past its timeout is killed, with a clear error, and its directory removed', async () => {
  fake.respond({ sleep: 5 });
  let dir = '';
  const err = await withTempDir('agentio-test-', (cwd) => {
    dir = cwd;
    return runExternalCli(CLAUDE_CLI, { args: [], input: '', cwd, unset: [], env: {}, timeoutMs: 300 });
  }).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).code).toBe('API_ERROR');
  expect((err as CliError).message).toContain('did not answer');
  expect(existsSync(dir)).toBe(false);
}, 10_000);
