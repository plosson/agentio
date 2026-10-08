import { describe, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../../helpers/setup-context';
import { withTempVault } from '../../../helpers/vault';
import { GCHAT_WEBHOOK_INPUT, gchatProfileAdd, gchatReauthenticate } from '../../../../src/plugins/google/gchat/commands';
import { CliError } from '../../../../src/utils/errors';
import type { OAuthTokens } from '../../../../src/plugins/google/tokens';

withTempVault('agentio-gchat-setup-', () => ({ config: { profiles: {} } as never }));

const TOKENS: OAuthTokens = { access_token: 'at', refresh_token: 'rt-new', expiry_date: 1234, token_type: 'Bearer', scope: 'a b' };
const HOOK = 'https://chat.googleapis.com/v1/spaces/S/messages?key=k&token=SECRET-TOKEN-123';

function stubs() {
  const oauthCalls: string[] = [];
  const performOAuth = (async (service: string) => { oauthCalls.push(service); return TOKENS; }) as never;
  const fetchEmail = (async () => 'a@b.c') as never;
  return { oauthCalls, performOAuth, fetchEmail };
}

/** A setup context whose fetch records its calls and answers with `status`. */
function contextWith(answers: Record<string, string>, status = 200) {
  const context = fakeSetupContext(answers);
  const calls: { url: string; method?: string }[] = [];
  context.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return new Response('', { status });
  }) as never;
  const logs: unknown[][] = [];
  context.log = (...parts: unknown[]) => { logs.push(parts); };
  return { context, calls, logs };
}

async function failure(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    return error as CliError;
  }
  throw new Error('expected a failure');
}

describe('gchatProfileAdd: webhook', () => {
  test('a URL on another host is refused, never echoed, and nothing is fetched', async () => {
    const { oauthCalls, performOAuth, fetchEmail } = stubs();
    const { context, calls, logs } = contextWith({ 'Profile type': 'webhook', 'Webhook URL': 'https://evil.example.com/SECRET-TOKEN-123' });
    const error = await failure(() => gchatProfileAdd({}, context, performOAuth, fetchEmail));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toBe('Not a Google Chat webhook URL');
    expect(error.suggestion).toBe('It starts with https://chat.googleapis.com/');
    expect(JSON.stringify(logs)).not.toContain('SECRET-TOKEN-123');
    expect(calls).toEqual([]);
    expect(oauthCalls).toEqual([]);
  });

  test('a lookalike host (chat.googleapis.com.evil.example) is refused', async () => {
    const { performOAuth, fetchEmail } = stubs();
    const { context, calls } = contextWith({ 'Profile type': 'webhook', 'Webhook URL': 'https://chat.googleapis.com.evil.example/x' });
    const error = await failure(() => gchatProfileAdd({}, context, performOAuth, fetchEmail));
    expect(error.message).toBe('Not a Google Chat webhook URL');
    expect(calls).toEqual([]);
  });

  test('a type outside the choices is refused before anything is asked or fetched', async () => {
    const { oauthCalls, performOAuth, fetchEmail } = stubs();
    const { context, calls } = contextWith({ 'Profile type': 'carrier-pigeon' });
    const error = await failure(() => gchatProfileAdd({}, context, performOAuth, fetchEmail));
    expect(error.code).toBe('INVALID_PARAMS');
    expect(calls).toEqual([]);
    expect(oauthCalls).toEqual([]);
  });

  test('a test POST answered 404 fails with API_ERROR', async () => {
    const { performOAuth, fetchEmail } = stubs();
    const { context, calls } = contextWith({ 'Profile type': 'webhook', 'Webhook URL': HOOK }, 404);
    const error = await failure(() => gchatProfileAdd({}, context, performOAuth, fetchEmail));
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toBe('Webhook validation failed: 404');
    expect(calls).toHaveLength(1);
  });

  test('a valid webhook: exact credentials, one POST, no sign-in, and the URL is in no log or info', async () => {
    const { oauthCalls, performOAuth, fetchEmail } = stubs();
    const { context, calls, logs } = contextWith({ 'Profile type': 'webhook', 'Webhook URL': HOOK });
    const result = await gchatProfileAdd({}, context, performOAuth, fetchEmail);
    expect(result.credentials).toEqual({ type: 'webhook', webhookUrl: HOOK });
    expect(calls).toEqual([{ url: HOOK, method: 'POST' }]);
    expect(oauthCalls).toEqual([]);
    expect(context.asked.map((spec) => spec.label)).toEqual(['Profile type', 'Webhook URL']);
    expect(result.suggestedProfileName).toBe('webhook');
    expect(result.info).not.toContain('SECRET-TOKEN-123');
    expect(JSON.stringify(logs)).not.toContain('SECRET-TOKEN-123');
  });

  test('--profile names the webhook profile', async () => {
    const { performOAuth, fetchEmail } = stubs();
    const { context } = contextWith({ 'Profile type': 'webhook', 'Webhook URL': HOOK });
    const result = await gchatProfileAdd({ profile: 'alerts' }, context, performOAuth, fetchEmail);
    expect(result.suggestedProfileName).toBe('alerts');
  });
});

describe('gchat reauthenticate', () => {
  test('a webhook profile asks for a new URL, checks it and returns it', async () => {
    const { oauthCalls, performOAuth, fetchEmail } = stubs();
    const { context, calls } = contextWith({ 'Webhook URL': HOOK });
    const result = await gchatReauthenticate(performOAuth, fetchEmail)({ type: 'webhook', webhookUrl: '' }, 'hook', context);
    expect(result).toEqual({ type: 'webhook', webhookUrl: HOOK });
    expect(context.asked).toEqual([GCHAT_WEBHOOK_INPUT]);
    expect(calls).toHaveLength(1);
    expect(oauthCalls).toEqual([]);
  });

  test('a webhook profile refuses a new URL on another host, with no fetch', async () => {
    const { performOAuth, fetchEmail } = stubs();
    const { context, calls } = contextWith({ 'Webhook URL': 'http://chat.googleapis.com/x' });
    const error = await failure(() => gchatReauthenticate(performOAuth, fetchEmail)({ type: 'webhook', webhookUrl: '' }, 'hook', context));
    expect(error.message).toBe('Not a Google Chat webhook URL');
    expect(calls).toEqual([]);
  });

  test('an OAuth profile with redacted credentials (no refreshToken) gets a new refreshToken', async () => {
    const { oauthCalls, performOAuth, fetchEmail } = stubs();
    const existing = { type: 'oauth', accessToken: '', expiryDate: 1, tokenType: 'Bearer', scope: 'x', email: 'old@b.c' } as never;
    const { context, calls } = contextWith({});
    const result = await gchatReauthenticate(performOAuth, fetchEmail)(existing, 'p', context);
    expect(oauthCalls).toEqual(['gchat']);
    expect(result).toMatchObject({ type: 'oauth', refreshToken: 'rt-new', email: 'a@b.c' });
    expect(context.asked).toEqual([]);
    expect(calls).toEqual([]);
  });
});
