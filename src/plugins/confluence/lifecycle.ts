import type { SetupContext } from '../../plugin-sdk';
import type { CredentialLifecycle } from '../types';
import { performConfluenceOAuthFlow, refreshConfluenceToken } from './oauth';
import type { ConfluenceCredentials } from './types';

export const confluenceCredentialLifecycle: CredentialLifecycle<ConfluenceCredentials> = {
  secretFields: ['refreshToken'],
  applies(credentials): credentials is ConfluenceCredentials {
    return typeof credentials === 'object' && credentials !== null
      && !!(credentials as Partial<ConfluenceCredentials>).refreshToken;
  },
  isStale(credentials, now, bufferMs) {
    return credentials.expiryDate !== undefined && now + bufferMs >= credentials.expiryDate;
  },
  async refresh(credentials) {
    const refreshed = await refreshConfluenceToken(credentials.refreshToken);
    return {
      ...credentials,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiryDate: Date.now() + refreshed.expiresIn * 1000,
    };
  },
};

export async function reauthenticateConfluence(
  credentials: ConfluenceCredentials | null,
  profileName: string,
  context: SetupContext,
): Promise<ConfluenceCredentials> {
  context.log(`\nRe-authenticating confluence / ${profileName}...`);
  const result = await performConfluenceOAuthFlow(context);
  context.log(`  Done (${result.siteUrl})`);
  return { ...credentials, ...result };
}
