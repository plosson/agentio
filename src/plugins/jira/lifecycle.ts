import { createSetupContext } from '../host-context';
import type { CredentialLifecycle } from '../types';
import { performJiraOAuthFlow, refreshJiraToken } from './oauth';
import type { JiraCredentials } from './types';

export const jiraCredentialLifecycle: CredentialLifecycle<JiraCredentials> = {
  secretFields: ['refreshToken'],
  applies(credentials): credentials is JiraCredentials {
    return typeof credentials === 'object'
      && credentials !== null
      && !!(credentials as Partial<JiraCredentials>).refreshToken;
  },
  isStale(credentials, now, bufferMs) {
    const expiry = credentials.expiryDate;
    return expiry !== undefined && now + bufferMs >= expiry;
  },
  async refresh(credentials) {
    const refreshed = await refreshJiraToken(credentials.refreshToken);
    return {
      ...credentials,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiryDate: Date.now() + refreshed.expiresIn * 1000,
    } satisfies JiraCredentials;
  },
};

export async function reauthenticateJira(
  credentials: JiraCredentials | null,
  profileName: string,
  performOAuth: typeof performJiraOAuthFlow = performJiraOAuthFlow
): Promise<JiraCredentials> {
  console.error(`\nRe-authenticating jira / ${profileName}...`);

  const result = await performOAuth(createSetupContext());
  const replacement: JiraCredentials = {
    ...credentials,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiryDate: result.expiryDate,
    cloudId: result.cloudId,
    siteUrl: result.siteUrl,
  };

  console.error(`  Done (${result.siteUrl})`);
  return replacement;
}
