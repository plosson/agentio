import { afterEach, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { chatGptProfileAdd } from '../../../src/plugins/chatgpt/commands';
import type { OAuthSetupOptions } from '../../../src/plugin-sdk';
import { FakeOpenAiAuth, jwt } from './fake-auth';

withTempVault('agentio-chatgpt-setup-', () => ({ config: { profiles: {} } as never }));

let auth: FakeOpenAiAuth | undefined;
afterEach(() => { auth?.restore(); auth = undefined; });

test('--api-key implies the key method and asks only for the model; a blank model is no model', async () => {
  const context = fakeSetupContext({ model: '' });
  const result = await chatGptProfileAdd({ apiKey: ' sk-x\n' }, context);
  expect(result.credentials).toEqual({ kind: 'apiKey', apiKey: 'sk-x' });
  expect(context.asked.map((s) => s.id)).toEqual(['model']);
});

test('answers alone can choose the key method and give a model', async () => {
  const result = await chatGptProfileAdd({}, fakeSetupContext({ method: 'apiKey', apiKey: 'sk-y', model: 'gpt-5.5' }));
  expect(result.credentials).toEqual({ kind: 'apiKey', apiKey: 'sk-y', model: 'gpt-5.5' });
});

test('an unknown method is refused before anything is asked or saved', async () => {
  await expect(chatGptProfileAdd({ method: 'other', model: '' }, fakeSetupContext({}))).rejects.toThrow('must be one of: chatgpt, apiKey');
});

test('an empty API key is refused', async () => {
  await expect(chatGptProfileAdd({ method: 'apiKey', apiKey: '  ', model: '' }, fakeSetupContext({}))).rejects.toThrow();
});

test('the ChatGPT method signs in on codex\'s registered port and path', async () => {
  auth = new FakeOpenAiAuth().answer({
    status: 200,
    body: {
      id_token: jwt({ email: 'me@x.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc' } }),
      access_token: jwt({ exp: 2e9 }),
      refresh_token: 'r1',
    },
  });
  const recorded: OAuthSetupOptions[] = [];
  const context = fakeSetupContext({ method: 'chatgpt', model: 'gpt-5.5' });
  context.oauth = async (options) => {
    recorded.push(options);
    return { code: 'c', redirectUri: 'http://localhost:1455/auth/callback' } as never;
  };
  const result = await chatGptProfileAdd({}, context);
  expect(result.credentials).toMatchObject({ kind: 'chatgpt', email: 'me@x.com', accountId: 'acc', refreshToken: 'r1', model: 'gpt-5.5' });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ port: 1455, path: '/auth/callback' });
});
