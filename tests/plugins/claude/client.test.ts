import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { ClaudeClient, tokenKind } from '../../../src/plugins/claude/client';
import { caught } from '../../helpers/caught';
import { installFakeCli, type FakeCli } from '../../helpers/fake-cli';

const OAUTH = 'sk-ant-oat01-SECRET-oauth';
const API = 'sk-ant-api03-SECRET-key';
const OK = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'Paris', total_cost_usd: 0.0135, duration_ms: 935,
  usage: { input_tokens: 9, output_tokens: 39 }, modelUsage: { 'claude-opus-5-5': { inputTokens: 9 } },
});

let fake: FakeCli;
beforeEach(async () => { fake = await installFakeCli('claude'); fake.respond({ stdout: OK }); });
afterEach(async () => { await fake.restore(); });


describe('tokenKind', () => {
  test('the prefix decides; anything else is refused', () => {
    expect(tokenKind(OAUTH)).toBe('oauth');
    expect(tokenKind(API)).toBe('apiKey');
    for (const bad of ['sk-proj-123', 'sk-ant-xyz', '', 'Bearer sk-ant-oat01-x']) expect(() => tokenKind(bad)).toThrow('not a Claude');
  });
});

describe('ask', () => {
  test('a plain question: no tools, no MCP, no settings, no session, the default short system prompt', async () => {
    await new ClaudeClient({ token: OAUTH, kind: 'oauth' }).ask({ prompt: 'Capital of France?' });
    const call = await fake.lastCall();
    expect(call.args).toEqual([
      '-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--system-prompt', 'You are a helpful assistant. Answer the request directly.',
    ]);
    expect(call.stdin).toBe('Capital of France?');
    expect(call.filesAtStart).toEqual([]);
    expect(existsSync(call.cwd)).toBe(false);
  });

  test('model, system prompt and effort are passed; the request\'s model wins over the profile\'s', async () => {
    await new ClaudeClient({ token: API, kind: 'apiKey', model: 'sonnet' }).ask({ prompt: 'x', model: 'opus', system: 'Be terse', effort: 'high' });
    const { args } = await fake.lastCall();
    expect(args.slice(args.indexOf('--system-prompt'))).toEqual(['--system-prompt', 'Be terse', '--model', 'opus', '--effort', 'high']);
  });

  test('nothing inherited reroutes claude: cloud-provider switches and a base URL are removed', async () => {
    const names = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL'];
    for (const name of names) process.env[name] = 'stray';
    await new ClaudeClient({ token: OAUTH, kind: 'oauth' }).ask({ prompt: 'x' });
    const { env } = await fake.lastCall();
    for (const name of names) expect([name, env[name]]).toEqual([name, null]);
  });

  test('the profile\'s token is the only credential claude sees', async () => {
    process.env.ANTHROPIC_API_KEY = 'stray-api';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stray-oauth';
    process.env.ANTHROPIC_AUTH_TOKEN = 'stray-auth';
    await new ClaudeClient({ token: OAUTH, kind: 'oauth' }).ask({ prompt: 'x' });
    expect((await fake.lastCall()).env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null });
    await new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' });
    expect((await fake.lastCall()).env).toMatchObject({ ANTHROPIC_API_KEY: API, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_AUTH_TOKEN: null });
  });

  test('the answer, model, usage, cost and duration come from claude\'s result', async () => {
    expect(await new ClaudeClient({ token: OAUTH, kind: 'oauth' }).ask({ prompt: 'x' })).toEqual({
      answer: 'Paris', model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 39 }, costUsd: 0.0135, durationMs: 935,
    });
  });

  test('a refused token is AUTH_FAILED, and the error never shows it', async () => {
    fake.respond({ exit: 1, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `Invalid API key ${OAUTH} · Please run /login`, api_error_status: 401 }) });
    const err = await caught(new ClaudeClient({ token: OAUTH, kind: 'oauth' }).ask({ prompt: 'x' }));
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.message).not.toContain(OAUTH);
    expect(err.suggestion).toContain('agentio claude profile add');
  });

  test('a rate limit is RATE_LIMITED; another failure is API_ERROR with claude\'s message', async () => {
    fake.respond({ exit: 1, stdout: JSON.stringify({ is_error: true, result: 'Too many requests', api_error_status: 429 }) });
    expect((await caught(new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' }))).code).toBe('RATE_LIMITED');
    fake.respond({ exit: 1, stdout: JSON.stringify({ is_error: true, result: 'model not found: opux' }) });
    const err = await caught(new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' }));
    expect([err.code, err.message]).toEqual(['API_ERROR', 'Claude Code failed: model not found: opux']);
  });

  test('output that is not claude\'s JSON is an error, with stderr when it crashed', async () => {
    fake.respond({ exit: 2, stderr: `error: unknown option '--tools' ${API}` });
    const crashed = await caught(new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' }));
    expect(crashed.code).toBe('API_ERROR');
    expect(crashed.message).toContain('unknown option');
    expect(crashed.message).not.toContain(API);
    fake.respond({ stdout: 'not json' });
    expect((await caught(new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' }))).code).toBe('API_ERROR');
    fake.respond({ stdout: JSON.stringify({ is_error: false }) });
    expect((await caught(new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' }))).code).toBe('API_ERROR');
  });

  test('no claude on PATH gives the install error', async () => {
    process.env.PATH = '/nonexistent';
    const err = await caught(new ClaudeClient({ token: API, kind: 'apiKey' }).ask({ prompt: 'x' }));
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.suggestion).toContain('claude.ai/install.sh');
  });
});
