import { describe, expect, test } from 'bun:test';
import { fakeSetupContext } from '../../helpers/setup-context';
import { googleCamelSetup, googleSnakeSetup, reauthenticateGoogleCamel, reauthenticateGoogleSnake, signInToGoogle, toCamelTokens } from '../../../src/plugins/google/shared';
import { CliError } from '../../../src/utils/errors';
import type { OAuthTokens } from '../../../src/plugins/google/tokens';

const TOKENS: OAuthTokens = {
  access_token: 'at',
  refresh_token: 'rt',
  expiry_date: 1234,
  token_type: 'Bearer',
  scope: 'a b',
};
const stubOAuth = (tokens: OAuthTokens = TOKENS) => (async () => tokens) as never;
const stubEmail = (email = 'a@b.c') => (async () => email) as never;
const OPTIONS = {};

async function failure(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    return error as CliError;
  }
  throw new Error('expected a failure');
}

describe('toCamelTokens', () => {
  test('tokens without refresh_token give an undefined refreshToken, not the string "undefined"', () => {
    const { refresh_token: _drop, ...rest } = TOKENS;
    const camel = toCamelTokens(rest as OAuthTokens);
    expect(camel.refreshToken).toBeUndefined();
    expect(JSON.stringify(camel)).not.toContain('undefined');
  });

  test('maps every field and leaks no snake field', () => {
    expect(toCamelTokens(TOKENS)).toEqual({ accessToken: 'at', refreshToken: 'rt', expiryDate: 1234, tokenType: 'Bearer', scope: 'a b' });
  });
});

describe('signInToGoogle', () => {
  test('a failing OAuth flow comes out unchanged, not wrapped', async () => {
    const denied = new CliError('AUTH_FAILED', 'access_denied');
    const error = await failure(() => signInToGoogle('gcal', fakeSetupContext({}), (async () => { throw denied; }) as never, stubEmail()));
    expect(error).toBe(denied);
  });

  test('a failing email lookup is AUTH_FAILED, names Google and keeps the lookup error text', async () => {
    const lookup = (async () => { throw new Error('userinfo 403'); }) as never;
    const error = await failure(() => signInToGoogle('gcal', fakeSetupContext({}), stubOAuth(), lookup));
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('Google');
    expect(error.message).toContain('userinfo 403');
    expect(error.suggestion).toBe('Try again');
  });

  test('a non-Error rejection is still reported', async () => {
    const lookup = (async () => { throw 'boom'; }) as never;
    const error = await failure(() => signInToGoogle('gcal', fakeSetupContext({}), stubOAuth(), lookup));
    expect(error.message).toContain('boom');
  });

  test('the OAuth flow gets the service id and the very context passed in; the lookup gets the access token', async () => {
    const context = fakeSetupContext({});
    const calls: unknown[][] = [];
    const lookedUp: string[] = [];
    const result = await signInToGoogle(
      'gslides',
      context,
      (async (...args: unknown[]) => { calls.push(args); return TOKENS; }) as never,
      (async (token: string) => { lookedUp.push(token); return 'a@b.c'; }) as never,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gslides');
    expect(calls[0][1]).toBe(context);
    expect(lookedUp).toEqual(['at']);
    expect(result).toEqual({ tokens: TOKENS, email: 'a@b.c' });
  });
});

describe('googleSnakeSetup', () => {
  test('stores the tokens as they come plus the email, names the profile by email, asks and opens nothing', async () => {
    const opened: string[] = [];
    const context = fakeSetupContext({}, opened);
    const result = await googleSnakeSetup('gcal', 'agentio gcal --help', stubOAuth(), stubEmail())(OPTIONS, context);
    expect(result.credentials).toEqual({ ...TOKENS, email: 'a@b.c' });
    expect(result.suggestedProfileName).toBe('a@b.c');
    expect(result.info).toStartWith('Email: a@b.c');
    expect(result.info).toEndWith('Test with: agentio gcal --help');
    expect(context.asked).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('a failing email lookup fails the setup', async () => {
    const lookup = (async () => { throw new Error('nope'); }) as never;
    const error = await failure(() => googleSnakeSetup('gtasks', 'x', stubOAuth(), lookup)(OPTIONS, fakeSetupContext({})));
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('nope');
  });
});

describe('googleCamelSetup', () => {
  test('stores exactly the camelCase shape, so no snake field leaks in', async () => {
    const result = await googleCamelSetup('gdocs', 'agentio gdocs list', stubOAuth(), stubEmail())(OPTIONS, fakeSetupContext({}));
    expect(result.credentials).toEqual({ accessToken: 'at', refreshToken: 'rt', expiryDate: 1234, tokenType: 'Bearer', scope: 'a b', email: 'a@b.c' });
    expect(result.suggestedProfileName).toBe('a@b.c');
    expect(result.info).toBe('Email: a@b.c\nTest with: agentio gdocs list');
  });

  test('refreshToken is present when the OAuth result has refresh_token, absent when it has not', async () => {
    const withToken = await googleCamelSetup('gdocs', 'x', stubOAuth(), stubEmail())(OPTIONS, fakeSetupContext({}));
    expect(withToken.credentials.refreshToken).toBe('rt');
    const { refresh_token: _drop, ...rest } = TOKENS;
    const without = await googleCamelSetup('gdocs', 'x', stubOAuth(rest as OAuthTokens), stubEmail())(OPTIONS, fakeSetupContext({}));
    expect(without.credentials.refreshToken).toBeUndefined();
  });

  test('a failing OAuth flow comes out unchanged', async () => {
    const denied = new CliError('AUTH_FAILED', 'access_denied');
    const error = await failure(() => googleCamelSetup('gsheets', 'x', (async () => { throw denied; }) as never, stubEmail())(OPTIONS, fakeSetupContext({})));
    expect(error).toBe(denied);
  });
});

describe('reauthenticateGoogleSnake', () => {
  // A remote "Sign in again" gets the credentials with the secret field removed.
  const REDACTED = { access_token: 'old-at', expiry_date: 1, email: 'old@b.c', custom: true };

  test('without refresh_token in the input: the result has the fresh tokens and keeps other fields', async () => {
    const fresh = { ...TOKENS, access_token: 'new-at', refresh_token: 'new-rt' };
    const result = await reauthenticateGoogleSnake('gmail', stubOAuth(fresh), stubEmail('new@b.c'))(REDACTED as never, 'p', fakeSetupContext({}));
    expect(result).toEqual({ ...fresh, email: 'new@b.c', custom: true } as never);
  });

  test('a failing email lookup is AUTH_FAILED, as in setup', async () => {
    const lookup = (async () => { throw new Error('userinfo 401'); }) as never;
    const error = await failure(() => reauthenticateGoogleSnake('gmail', stubOAuth(), lookup)(REDACTED as never, 'p', fakeSetupContext({})));
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('userinfo 401');
  });
});

describe('reauthenticateGoogleCamel', () => {
  const REDACTED = { accessToken: 'old-at', expiryDate: 1, email: 'old@b.c', custom: true };

  test('without refreshToken in the input: the result has the fresh tokens and keeps other fields', async () => {
    const fresh = { ...TOKENS, access_token: 'new-at', refresh_token: 'new-rt' };
    const result = await reauthenticateGoogleCamel('gdocs', stubOAuth(fresh), stubEmail('new@b.c'))(REDACTED as never, 'p', fakeSetupContext({}));
    expect(result).toEqual({
      accessToken: 'new-at', refreshToken: 'new-rt', expiryDate: 1234, tokenType: 'Bearer', scope: 'a b', email: 'new@b.c', custom: true,
    } as never);
  });

  test('a failing email lookup is AUTH_FAILED, as in setup', async () => {
    const lookup = (async () => { throw 'boom'; }) as never;
    const error = await failure(() => reauthenticateGoogleCamel('gdocs', stubOAuth(), lookup)(REDACTED as never, 'p', fakeSetupContext({})));
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('boom');
  });
});
