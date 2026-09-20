import { describe, expect, mock, test } from 'bun:test';
import { redactForRemote } from '../../../src/auth/refresh';
import {
  googleCamelCredentialLifecycle,
  googleSnakeCredentialLifecycle,
  reauthenticateGoogleCamel,
  reauthenticateGoogleSnake,
  type GoogleCamelCredentials,
  type GoogleSnakeCredentials,
} from '../../../src/plugins/google/shared';

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

  test('reauthenticates snake and camel credential shapes through shared code', async () => {
    const performOAuth = mock(async () => tokens);
    const fetchEmail = mock(async () => 'user@example.test');

    const snake = await reauthenticateGoogleSnake<GoogleSnakeCredentials & { custom: boolean }>('gslides', performOAuth, fetchEmail)(
      { access_token: 'old', refresh_token: 'old-refresh', token_type: 'Bearer', custom: true },
      'work',
    );
    const camel = await reauthenticateGoogleCamel<GoogleCamelCredentials & { custom: boolean }>('gscript', performOAuth, fetchEmail)(
      { accessToken: 'old', refreshToken: 'old-refresh', tokenType: 'Bearer', custom: true },
      'work',
    );

    expect(snake).toMatchObject({ access_token: 'access-new', refresh_token: 'refresh-new', email: 'user@example.test', custom: true });
    expect(camel).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new', email: 'user@example.test', custom: true });
    expect(performOAuth).toHaveBeenCalledTimes(2);
  });
});
