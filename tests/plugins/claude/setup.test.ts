import { expect, test } from 'bun:test';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { claudeProfileAdd, CLAUDE_CREATE_TOKEN_INPUT } from '../../../src/plugins/claude/commands';
import { installFakeCli, type FakeCli } from '../../helpers/fake-cli';

withTempVault('agentio-claude-setup-', () => ({ config: { profiles: {} } as never }));

test('the kind follows the prefix, the token is trimmed, a blank model is no model', async () => {
  const oauth = await claudeProfileAdd({ token: ' sk-ant-oat01-abc\n', model: '' }, fakeSetupContext({}));
  expect(oauth.credentials).toEqual({ token: 'sk-ant-oat01-abc', kind: 'oauth' });
  const api = await claudeProfileAdd({}, fakeSetupContext({ 'How do you want to add Claude?': 'paste', 'Token or API key': 'sk-ant-api03-abc', 'Default model': 'opus' }));
  expect(api.credentials).toEqual({ token: 'sk-ant-api03-abc', kind: 'apiKey', model: 'opus' });
  expect(api.suggestedProfileName).toBe('default');
  expect(api.info ?? '').not.toContain('sk-ant-api03-abc');
});

test('a token of another provider is refused before anything is saved, and never repeated', async () => {
  for (const token of ['sk-proj-SECRET', 'sk-ant-SECRET', 'oat01-SECRET']) {
    const err = await claudeProfileAdd({ token, model: '' }, fakeSetupContext({})).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('not a Claude') });
    expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain('SECRET');
  }
});

test('setup never runs claude: it works with no claude on PATH', async () => {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    expect((await claudeProfileAdd({ token: 'sk-ant-oat01-abc', model: '' }, fakeSetupContext({}))).credentials.kind).toBe('oauth');
  } finally {
    process.env.PATH = path;
  }
});

/** A terminal-like context: records the logs and the programs run in the terminal. */
function terminalContext(answers: Record<string, string>, exit = 0) {
  const ran: (readonly string[])[] = [];
  const logs: string[] = [];
  const context = {
    ...fakeSetupContext(answers),
    log: (...parts: unknown[]) => { logs.push(parts.join(' ')); },
    async runInTerminal(command: readonly string[]) { ran.push(command); return exit; },
  };
  // fakeSetupContext records into its own `asked`; keep the same array visible on the copy.
  return { context, ran, logs };
}

async function withFakeClaude<T>(fn: (cli: FakeCli) => Promise<T>): Promise<T> {
  const cli = await installFakeCli('claude');
  try {
    return await fn(cli);
  } finally {
    await cli.restore();
  }
}

const TOKEN = 'sk-ant-oat01-abc';

test('terminal setup offers to create the token, runs claude setup-token, then asks for the token and model', async () => {
  await withFakeClaude(async (cli) => {
    const { context, ran, logs } = terminalContext({ 'How do you want to add Claude?': 'setupToken', 'Token or API key': TOKEN, 'Default model': 'opus' });
    const result = await claudeProfileAdd({}, context);
    expect(context.asked.map((s) => s.label)).toEqual(['How do you want to add Claude?', 'Token or API key', 'Default model']);
    expect(context.asked[0]).toEqual(CLAUDE_CREATE_TOKEN_INPUT);
    expect(ran).toEqual([[join(cli.binDir, 'claude'), 'setup-token']]);
    expect(logs.some((l) => l.includes('claude setup-token'))).toBe(true);
    expect(result.credentials).toEqual({ token: TOKEN, kind: 'oauth', model: 'opus' });
  });
});

test('the question about creating a token is a choice that defaults to creating the token', () => {
  expect(CLAUDE_CREATE_TOKEN_INPUT).toEqual({
    label: 'How do you want to add Claude?', kind: 'choice', default: 'setupToken',
    choices: [
      { value: 'setupToken', label: 'Create a subscription token now (runs claude setup-token)' },
      { value: 'paste', label: 'Paste a token or API key I already have' },
    ],
  });
});

test('pasting a token runs nothing', async () => {
  await withFakeClaude(async () => {
    const { context, ran } = terminalContext({ 'How do you want to add Claude?': 'paste', 'Token or API key': TOKEN, 'Default model': '' });
    await claudeProfileAdd({}, context);
    expect(ran).toEqual([]);
    expect(context.asked.map((s) => s.label)).toEqual(['How do you want to add Claude?', 'Token or API key', 'Default model']);
  });
});

test('a setup-token that fails is logged, and the token can still be pasted', async () => {
  await withFakeClaude(async () => {
    const { context, ran, logs } = terminalContext({ 'How do you want to add Claude?': 'setupToken', 'Token or API key': TOKEN, 'Default model': '' }, 1);
    const result = await claudeProfileAdd({}, context);
    expect(ran).toHaveLength(1);
    expect(logs.some((l) => l.includes('did not finish') && l.includes('paste'))).toBe(true);
    expect(context.asked.map((s) => s.label)).toEqual(['How do you want to add Claude?', 'Token or API key', 'Default model']);
    expect(result.credentials.token).toBe(TOKEN);
  });
});

test('terminal setup without claude on PATH asks no question, runs nothing, and says how to install it', async () => {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const { context, ran, logs } = terminalContext({ 'Token or API key': TOKEN, 'Default model': '' });
    await claudeProfileAdd({}, context);
    expect(context.asked.map((s) => s.label)).toEqual(['Token or API key', 'Default model']);
    expect(ran).toEqual([]);
    expect(logs.filter((l) => l.includes('curl -fsSL https://claude.ai/install.sh | bash'))).toHaveLength(1);
  } finally {
    process.env.PATH = path;
  }
});

test('--token given: nothing about creating is asked or run, and no install hint is logged', async () => {
  await withFakeClaude(async () => {
    const { context, ran, logs } = terminalContext({ 'Default model': '' });
    await claudeProfileAdd({ token: TOKEN }, context);
    expect(context.asked.map((s) => s.label)).toEqual(['Default model']);
    expect(ran).toEqual([]);
    expect(logs).toEqual([]);
  });
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const { context, logs } = terminalContext({ 'Default model': '' });
    await claudeProfileAdd({ token: TOKEN }, context);
    expect(logs).toEqual([]);
  } finally {
    process.env.PATH = path;
  }
});
