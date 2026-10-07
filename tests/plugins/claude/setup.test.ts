import { expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { claudeProfileAdd } from '../../../src/plugins/claude/commands';

withTempVault('agentio-claude-setup-', () => ({ config: { profiles: {} } as never }));

test('the kind follows the prefix, the token is trimmed, a blank model is no model', async () => {
  const oauth = await claudeProfileAdd({ token: ' sk-ant-oat01-abc\n', model: '' }, fakeSetupContext({}));
  expect(oauth.credentials).toEqual({ token: 'sk-ant-oat01-abc', kind: 'oauth' });
  const api = await claudeProfileAdd({}, fakeSetupContext({ token: 'sk-ant-api03-abc', model: 'opus' }));
  expect(api.credentials).toEqual({ token: 'sk-ant-api03-abc', kind: 'apiKey', model: 'opus' });
});

test('a token of another provider is refused before anything is saved', async () => {
  for (const token of ['sk-proj-abc', 'sk-ant-other', 'oat01']) {
    await expect(claudeProfileAdd({ token, model: '' }, fakeSetupContext({}))).rejects.toThrow('not a Claude');
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
