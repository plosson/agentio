import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildAuthorizeUrl, credentialsFromTokens, exchangeCode, refreshTokens, CODEX_CLIENT_ID } from '../../../src/plugins/chatgpt/oauth';
import { caught, FakeOpenAiAuth, jwt } from './fake-auth';
const ID = jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } });
const ACCESS = jwt({ exp: 2_000_000_000 });

let auth: FakeOpenAiAuth;
beforeEach(() => { auth = new FakeOpenAiAuth(); });
afterEach(() => auth.restore());

test('the authorize URL is Codex\'s, with PKCE and the callback given', () => {
  const url = new URL(buildAuthorizeUrl({ redirectUri: 'http://localhost:1455/auth/callback', challenge: 'ch', state: 'st' }));
  expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access', code_challenge: 'ch', code_challenge_method: 'S256',
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', state: 'st', originator: 'codex_cli_rs',
  });
});

test('the code exchange posts the verifier and the same redirect', async () => {
  auth.answer({ status: 200, body: { id_token: ID, access_token: ACCESS, refresh_token: 'r1' } });
  await exchangeCode('code1', 'ver1', 'http://localhost:1455/auth/callback');
  expect(auth.log[0].body).toEqual({ grant_type: 'authorization_code', code: 'code1', redirect_uri: 'http://localhost:1455/auth/callback', client_id: CODEX_CLIENT_ID, code_verifier: 'ver1' });
});

describe('credentialsFromTokens', () => {
  test('account and email from the id token, expiry from the access token', () => {
    expect(credentialsFromTokens({ id_token: ID, access_token: ACCESS, refresh_token: 'r1' })).toEqual({
      kind: 'chatgpt', accessToken: ACCESS, refreshToken: 'r1', idToken: ID, accountId: 'acc-1', email: 'me@example.com', expiresAt: 2_000_000_000_000,
    });
  });

  test('a refresh without a new refresh or id token keeps the old ones; one without an access token is refused', () => {
    const before = credentialsFromTokens({ id_token: ID, access_token: ACCESS, refresh_token: 'r1' });
    expect(credentialsFromTokens({ access_token: ACCESS }, before)).toMatchObject({ refreshToken: 'r1', idToken: ID, accountId: 'acc-1' });
    expect(() => credentialsFromTokens({ id_token: ID }, before)).toThrow('access token');
  });

  test('a first sign-in without a refresh token or account is refused', () => {
    expect(() => credentialsFromTokens({ id_token: ID, access_token: ACCESS })).toThrow('refresh token');
    expect(() => credentialsFromTokens({ id_token: jwt({}), access_token: ACCESS, refresh_token: 'r' })).toThrow('account');
  });

  test('an access token without a readable expiry expires in an hour', () => {
    const now = Date.now();
    const c = credentialsFromTokens({ id_token: ID, access_token: 'opaque', refresh_token: 'r' });
    expect(c.expiresAt! - now).toBeGreaterThan(59 * 60_000);
    expect(c.expiresAt! - now).toBeLessThan(61 * 60_000);
  });
});

describe('refreshTokens', () => {
  test('posts JSON with the refresh token and Codex\'s client id', async () => {
    auth.answer({ status: 200, body: { access_token: ACCESS, refresh_token: 'r2' } });
    expect(await refreshTokens('r1')).toEqual({ access_token: ACCESS, refresh_token: 'r2' });
    expect(auth.log[0].body).toEqual({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'r1', scope: 'openid profile email' });
  });

  test('a refused refresh is AUTH_EXPIRED with the reauth command; the token never shows', async () => {
    auth.answer({ status: 401, body: { error: 'refresh_token_reused', error_description: 'r1 was already used' } });
    const err = await caught(refreshTokens('r1'));
    expect(err.code).toBe('AUTH_EXPIRED');
    expect(err.suggestion).toContain('agentio profile reauth chatgpt');
    expect(err.message).not.toContain('r1 ');
  });

  test('a server failure is API_ERROR, no network is NETWORK_ERROR', async () => {
    auth.answer({ status: 500, raw: 'oops' });
    expect((await caught(refreshTokens('r1'))).code).toBe('API_ERROR');
    auth.answer('network-error');
    expect((await caught(refreshTokens('r1'))).code).toBe('NETWORK_ERROR');
  });
});
