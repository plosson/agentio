import { interactiveSelect } from '../../utils/interactive';
import type { CredentialLifecycle } from '../types';
import { performConfluenceOAuthFlow, refreshConfluenceToken, type AtlassianSite } from './oauth';
import type { ConfluenceCredentials } from './types';

async function selectConfluenceSite(sites: AtlassianSite[]): Promise<AtlassianSite> {
  return interactiveSelect({
    message: 'Select a Confluence site:',
    choices: sites.map((site) => ({ name: site.name, value: site, description: site.url })),
  });
}

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
): Promise<ConfluenceCredentials> {
  console.error(`\nRe-authenticating confluence / ${profileName}...`);
  const result = await performConfluenceOAuthFlow(selectConfluenceSite);
  console.error(`  Done (${result.siteUrl})`);
  return { ...credentials, ...result };
}
