import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chatGptCredentialLifecycle as life, reauthenticateChatGpt } from '../../../src/plugins/chatgpt/lifecycle';
import type { ChatGptCredentials } from '../../../src/plugins/chatgpt/types';
import { redactForRemote } from '../../../src/auth/refresh';
import { fakeSetupContext } from '../../helpers/setup-context';
import { FakeOpenAiAuth, jwt } from './fake-auth';

const SIGNED_IN: ChatGptCredentials = { kind: 'chatgpt', accessToken: 'a', refreshToken: 'r1', idToken: 'i', accountId: 'acc', expiresAt: 1_000, model: 'gpt-5.5' };

let auth: FakeOpenAiAuth;
beforeEach(() => { auth = new FakeOpenAiAuth(); });
afterEach(() => auth.restore());

test('applies to a ChatGPT sign-in only, never to an API key', () => {
  expect(life.applies(SIGNED_IN)).toBe(true);
  expect(life.applies({ kind: 'apiKey', apiKey: 'sk' })).toBe(false);
  expect(life.applies({ kind: 'chatgpt', accessToken: 'a' })).toBe(false); // remote copy: no refresh token
  expect(life.applies(null)).toBe(false);
});

test('stale within the buffer, or without an expiry', () => {
  expect(life.isStale(SIGNED_IN, 500, 499)).toBe(false);
  expect(life.isStale(SIGNED_IN, 500, 500)).toBe(true);
  expect(life.isStale({ ...SIGNED_IN, expiresAt: undefined }, 0, 0)).toBe(true);
});

test('refresh replaces the rotating token and keeps the model', async () => {
  auth.answer({ status: 200, body: { access_token: jwt({ exp: 3_000 }), refresh_token: 'r2' } });
  const next = await life.refresh(SIGNED_IN);
  expect(next).toMatchObject({ refreshToken: 'r2', expiresAt: 3_000_000, accountId: 'acc', model: 'gpt-5.5' });
});

test('a remote agent never receives the refresh token', () => {
  const remote = redactForRemote('chatgpt', SIGNED_IN as unknown as Record<string, unknown>);
  expect(remote.refreshToken).toBeUndefined();
  expect(remote.accessToken).toBe('a');
});

test('reauth of an API key profile is refused: there is nothing to sign in to', async () => {
  await expect(reauthenticateChatGpt({ kind: 'apiKey', apiKey: 'sk' }, 'p', fakeSetupContext({}))).rejects.toThrow('API key');
});
