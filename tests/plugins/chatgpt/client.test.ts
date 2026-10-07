import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { ChatGptClient } from '../../../src/plugins/chatgpt/client';
import type { ChatGptCredentials } from '../../../src/plugins/chatgpt/types';
import { CliError } from '../../../src/utils/errors';
import { installFakeCli, type FakeCli } from '../../helpers/fake-cli';

const SIGNED_IN: ChatGptCredentials = {
  kind: 'chatgpt', accessToken: 'ACCESS-1', refreshToken: 'REFRESH-SECRET', idToken: 'ID-1', accountId: 'acc-1', expiresAt: 9e12,
};
const EVENTS = [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }),
].join('\n');

let fake: FakeCli;
beforeEach(async () => { fake = await installFakeCli('codex'); fake.respond({ stdout: EVENTS, answer: 'Paris' }); });
afterEach(async () => { await fake.restore(); });
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CliError; } throw new Error('expected an error'); };

test('codex runs isolated, read-only, ephemeral, with the prompt on stdin', async () => {
  await new ChatGptClient(SIGNED_IN).ask({ prompt: 'Capital of France?' });
  const call = await fake.lastCall();
  const out = call.args[call.args.indexOf('-o') + 1];
  expect(call.args).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '--json', '-o', out, '-']);
  expect(call.stdin).toBe('Capital of France?');
  expect(call.filesAtStart).toEqual([]);
  expect(existsSync(call.cwd)).toBe(false);
  expect(existsSync(call.env.CODEX_HOME!)).toBe(false);
  expect(call.env.CODEX_HOME).not.toBe(call.cwd);
});

test('codex gets an access token and never the refresh token', async () => {
  await new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' });
  const { codexHome } = await fake.lastCall();
  expect(codexHome.files).toEqual(['auth.json']);
  expect(codexHome.authJson).not.toContain('REFRESH-SECRET');
  const auth = JSON.parse(codexHome.authJson!);
  expect(auth).toMatchObject({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'ID-1', access_token: 'ACCESS-1', refresh_token: '', account_id: 'acc-1' } });
  expect(Date.now() - Date.parse(auth.last_refresh)).toBeLessThan(60_000);
});

test('an API key goes in CODEX_API_KEY, with no auth.json; stray keys are removed', async () => {
  process.env.OPENAI_API_KEY = 'stray';
  process.env.CODEX_API_KEY = 'stray';
  await new ChatGptClient({ kind: 'apiKey', apiKey: 'sk-profile' }).ask({ prompt: 'x' });
  const call = await fake.lastCall();
  expect(call.env).toMatchObject({ CODEX_API_KEY: 'sk-profile', OPENAI_API_KEY: null });
  expect(call.codexHome.files).toEqual([]);
});

test('model, system prompt and effort become codex options, as TOML strings', async () => {
  await new ChatGptClient({ ...SIGNED_IN, model: 'gpt-5.4' }).ask({ prompt: 'x', model: 'gpt-5.5', system: 'Say "hi"\nthen stop', effort: 'high' });
  const { args } = await fake.lastCall();
  const rest = args.slice(args.indexOf('-o') + 2, -1);
  expect(rest).toEqual(['-m', 'gpt-5.5', '-c', 'developer_instructions="Say \\"hi\\"\\nthen stop"', '-c', 'model_reasoning_effort="high"']);
});

test('the answer comes from the -o file; usage from the turn.completed event', async () => {
  expect(await new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' })).toEqual({
    answer: 'Paris', model: null, usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 }, costUsd: null, durationMs: expect.any(Number),
  });
});

test('exit 0 with no answer file, or an empty one, is an error, not an empty answer', async () => {
  fake.respond({ stdout: EVENTS });
  expect((await fails(new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' }))).code).toBe('API_ERROR');
  fake.respond({ stdout: EVENTS, answer: '  \n' });
  expect((await fails(new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' }))).code).toBe('API_ERROR');
});

test('a failed turn gives codex\'s message; a 401 is AUTH_EXPIRED; tokens never show', async () => {
  fake.respond({ exit: 1, stdout: JSON.stringify({ type: 'turn.failed', error: { message: 'model not supported' } }) });
  const err = await fails(new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' }));
  expect([err.code, err.message]).toEqual(['API_ERROR', 'Codex failed: model not supported']);
  fake.respond({ exit: 1, stdout: JSON.stringify({ type: 'error', message: 'unexpected status 401 Unauthorized ACCESS-1' }) });
  const auth = await fails(new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' }));
  expect(auth.code).toBe('AUTH_EXPIRED');
  expect(auth.message).not.toContain('ACCESS-1');
});

test('a sign-in profile without its access token is refused before codex runs', async () => {
  const err = await fails(new ChatGptClient({ kind: 'chatgpt', refreshToken: 'r' }).ask({ prompt: 'x' }));
  expect(err.code).toBe('AUTH_FAILED');
});

test('no codex on PATH gives the install error', async () => {
  process.env.PATH = '/nonexistent';
  expect((await fails(new ChatGptClient(SIGNED_IN).ask({ prompt: 'x' }))).suggestion).toContain('npm i -g @openai/codex');
});
