import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { redactForRemote } from '../../../src/auth/refresh';
import {
  assertSameAccount,
  googleCamelCredentialLifecycle,
  googleSnakeCredentialLifecycle,
  reauthenticateGoogle,
} from '../../../src/plugins/google/shared';
import gchat from '../../../src/plugins/google/gchat';

const tokens = {
  access_token: 'access-new',
  refresh_token: 'refresh-new',
  expiry_date: 20_000,
  token_type: 'Bearer',
  scope: 'scope',
};

describe('shared Google plugin lifecycle', () => {
  test('recognizes both credential formats and applies their expiry fields', () => {
    const snake = { access_token: 'a', refresh_token: 'r', expiry_date: 10_000, token_type: 'Bearer' };
    const camel = { accessToken: 'a', refreshToken: 'r', expiryDate: 10_000, tokenType: 'Bearer' };

    expect(googleSnakeCredentialLifecycle.applies(snake)).toBe(true);
    expect(googleSnakeCredentialLifecycle.isStale(snake, 4_000, 6_000)).toBe(true);
    expect(googleCamelCredentialLifecycle.applies(camel)).toBe(true);
    expect(googleCamelCredentialLifecycle.isStale(camel, 3_999, 6_000)).toBe(false);
    expect(googleCamelCredentialLifecycle.applies({ type: 'webhook', webhookUrl: 'https://example.test' })).toBe(false);
  });

  test('redacts the correct refresh field for each Google service', () => {
    expect(redactForRemote('gmail', { access_token: 'a', refresh_token: 'r' })).toEqual({ access_token: 'a' });
    expect(redactForRemote('gdocs', { accessToken: 'a', refreshToken: 'r' })).toEqual({ accessToken: 'a' });
  });
});

describe('reauthenticateGoogle', () => {
  let errorSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  const emailIs = (email: string) => mock(async () => email);

  test('keeps fields the plugin stored, in both credential shapes', async () => {
    const performOAuth = mock(async (..._keys: unknown[]) => tokens);
    const snake = await reauthenticateGoogle<Record<string, unknown>>('gmail', performOAuth, emailIs('user@example.test'))(
      { access_token: 'old', refresh_token: 'old-refresh', token_type: 'Bearer', custom: true },
      'work',
    );
    const camel = await reauthenticateGoogle<Record<string, unknown>>('gscript', performOAuth, emailIs('user@example.test'))(
      { accessToken: 'old', refreshToken: 'old-refresh', tokenType: 'Bearer', custom: true },
      'work',
    );

    expect(snake).toMatchObject({ access_token: 'access-new', refresh_token: 'refresh-new', email: 'user@example.test', custom: true });
    expect(camel).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new', email: 'user@example.test', custom: true });
    expect(performOAuth.mock.calls.map((call) => call[0])).toEqual(['gmail', 'gscript']);
  });

  test('Drive renews with the level it had, and read-only when none was stored', async () => {
    const performOAuth = mock(async (..._keys: unknown[]) => tokens);
    const renew = reauthenticateGoogle<Record<string, unknown>>('gdrive', performOAuth, emailIs('user@example.test'));

    expect(await renew({ accessToken: 'old', tokenType: 'Bearer', accessLevel: 'full' }, 'w')).toMatchObject({ accessLevel: 'full' });
    expect(await renew(null, 'w')).toMatchObject({ accessLevel: 'readonly' });
    expect(performOAuth.mock.calls.map((call) => call[0])).toEqual(['gdrive-full', 'gdrive-readonly']);
  });

  test('refuses a consent made with another account, names both, and returns nothing', async () => {
    const renew = reauthenticateGoogle<Record<string, unknown>>('gmail', mock(async () => tokens), emailIs('home@example.test'));
    const attempt = renew({ access_token: 'old', token_type: 'Bearer', email: 'work@example.test' }, 'work');

    await expect(attempt).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(attempt).rejects.toThrow('Signed in as home@example.test, but this profile belongs to work@example.test');
  });

  test('the same account in other letter case is the same account', async () => {
    const renew = reauthenticateGoogle<Record<string, unknown>>('gcal', mock(async () => tokens), emailIs('me@example.test'));
    expect(await renew({ access_token: 'old', token_type: 'Bearer', email: 'Me@Example.TEST' }, 'w')).toMatchObject({ email: 'me@example.test' });
  });

  test('an older profile with no stored email takes the new one', async () => {
    const renew = reauthenticateGoogle<Record<string, unknown>>('gdocs', mock(async () => tokens), emailIs('me@example.test'));
    expect(await renew({ accessToken: 'old', tokenType: 'Bearer' }, 'w')).toMatchObject({ email: 'me@example.test' });
  });

  test('a service outside the Google suite fails when the plugin is defined', () => {
    expect(() => reauthenticateGoogle('slack')).toThrow();
  });

  test('a Chat webhook profile is left as it is, with no browser', async () => {
    const hook = { type: 'webhook' as const, webhookUrl: 'https://chat.example.test/hook' };
    expect(await gchat.profile!.reauthenticate!(hook, 'hook')).toEqual(hook);
  });
});

describe('assertSameAccount', () => {
  test('passes when nothing was stored, or the stored value is not an email string', () => {
    expect(() => assertSameAccount(undefined, 'a@x.com')).not.toThrow();
    expect(() => assertSameAccount('', 'a@x.com')).not.toThrow();
    expect(() => assertSameAccount(42, 'a@x.com')).not.toThrow();
  });
});
