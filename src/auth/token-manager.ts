import { OAuth2Client } from 'google-auth-library';
import { getFreshCredentials } from './refresh';
import { requireProfile } from '../utils/client-factory';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';

export async function getValidTokens(
  service: ServiceName,
  profileName?: string
): Promise<{ tokens: OAuthTokens; profile: string }> {
  const profile = await requireProfile(service, profileName);
  const { credentials } = await getFreshCredentials<OAuthTokens>(service, profile);
  return { tokens: credentials, profile };
}

function newGoogleOAuthClient(): OAuth2Client {
  return new OAuth2Client(GOOGLE_OAUTH_CONFIG.clientId, GOOGLE_OAUTH_CONFIG.clientSecret);
}

/**
 * Exchange the refresh token for a new access token. Pure: the caller decides
 * where the result is stored. Google normally keeps the refresh token and
 * scope, so the stored ones are kept when the response omits them.
 */
export async function refreshGoogleAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refresh_token) throw new Error('no refresh token stored');
  const oauth2Client = newGoogleOAuthClient();
  oauth2Client.setCredentials({ refresh_token: tokens.refresh_token });

  const { credentials } = await oauth2Client.refreshAccessToken();
  return {
    access_token: credentials.access_token!,
    refresh_token: credentials.refresh_token || tokens.refresh_token,
    expiry_date: credentials.expiry_date || undefined,
    token_type: credentials.token_type || 'Bearer',
    scope: credentials.scope || tokens.scope,
  };
}

export function createGoogleAuth(tokens: OAuthTokens) {
  const oauth2Client = newGoogleOAuthClient();

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
