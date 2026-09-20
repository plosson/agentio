import { describe, expect, mock, test } from 'bun:test';
import { redactForRemote } from '../../../src/auth/refresh';
import { jiraCredentialLifecycle, reauthenticateJira } from '../../../src/plugins/jira/lifecycle';
import type { JiraCredentials } from '../../../src/plugins/jira/types';

const credentials: JiraCredentials = {
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  expiryDate: 10_000,
  cloudId: 'cloud-old',
  siteUrl: 'https://old.atlassian.net',
};

describe('Jira credential lifecycle', () => {
  test('recognizes refreshable credentials and applies the expiry buffer', () => {
    expect(jiraCredentialLifecycle.applies(credentials)).toBe(true);
    expect(jiraCredentialLifecycle.applies({ accessToken: 'static' })).toBe(false);
    expect(jiraCredentialLifecycle.applies(null)).toBe(false);
    expect(jiraCredentialLifecycle.isStale(credentials, 4_000, 6_000)).toBe(true);
    expect(jiraCredentialLifecycle.isStale(credentials, 3_999, 6_000)).toBe(false);
    expect(jiraCredentialLifecycle.isStale(
      { ...credentials, expiryDate: undefined } as unknown as JiraCredentials,
      4_000,
      6_000,
    )).toBe(false);
  });

  test('redacts refresh material through the host credential API', () => {
    expect(redactForRemote('jira', { ...credentials })).toEqual({
      accessToken: 'access-old',
      expiryDate: 10_000,
      cloudId: 'cloud-old',
      siteUrl: 'https://old.atlassian.net',
    });
    expect(credentials.refreshToken).toBe('refresh-old');
  });

  test('reauthentication returns replacement credentials without persisting them', async () => {
    const performOAuth = mock(async () => ({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiryDate: 20_000,
      cloudId: 'cloud-new',
      siteUrl: 'https://new.atlassian.net',
    }));

    const replacement = await reauthenticateJira(credentials, 'work', performOAuth);

    expect(performOAuth).toHaveBeenCalledTimes(1);
    expect(replacement).toEqual({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiryDate: 20_000,
      cloudId: 'cloud-new',
      siteUrl: 'https://new.atlassian.net',
    });
    expect(credentials.accessToken).toBe('access-old');
  });
});
