import { OAuth2Client } from 'google-auth-library';
import { getFreshCredentials } from './refresh';
import { resolveProfile } from '../config/config-manager';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import { CliError, multipleProfilesError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';

export async function getValidTokens(
  service: ServiceName,
  profileName?: string
): Promise<{ tokens: OAuthTokens; profile: string }> {
  const profileResult = await resolveProfile(service, profileName);

  if (profileResult.profile === null) {
    if (profileResult.error === 'none') {
      if (profileName) {
        throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for ${service}`, `Run: agentio ${service} profile add`);
      }
      throw new CliError('PROFILE_NOT_FOUND', `No ${service} profile configured`, `Run: agentio ${service} profile add`);
    }
    throw multipleProfilesError(service, profileResult.names);
  }

  const profile = profileResult.profile;


  const { credentials } = await getFreshCredentials<OAuthTokens>(service, profile);
  return { tokens: credentials, profile };
}

/**
 * Exchange a Google refresh token for a new access token. Pure: the caller
 * decides where the result is stored. Google normally keeps the refresh
 * token, so `refreshToken` is only set when a new one came back.
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
}> {
  const oauth2Client = new OAuth2Client(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const { credentials } = await oauth2Client.refreshAccessToken();
  return {
    accessToken: credentials.access_token!,
    refreshToken: credentials.refresh_token || undefined,
    expiryDate: credentials.expiry_date || undefined,
    tokenType: credentials.token_type || 'Bearer',
    scope: credentials.scope || undefined,
  };
}

export function createGoogleAuth(tokens: OAuthTokens) {
  const oauth2Client = new OAuth2Client(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret
  );

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  return oauth2Client;
}

/**
 * Fetch user email from Google's userinfo endpoint
 */
export async function fetchGoogleUserEmail(accessToken: string): Promise<string> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  const data = await response.json() as { email?: string };
  if (!data.email) {
    throw new Error('No email returned from userinfo endpoint');
  }

  return data.email;
}
