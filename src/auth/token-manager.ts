import { OAuth2Client } from 'google-auth-library';
import { getCredentials, setCredentials } from './token-store';
import { resolveProfile } from '../config/config-manager';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import { CliError, multipleProfilesError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

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

  const tokens = await getCredentials<OAuthTokens>(service, profile);

  if (!tokens) {
    throw new CliError(
      'AUTH_FAILED',
      `No tokens found for ${service} profile "${profile}"`,
      `Run: agentio ${service} profile add --profile ${profile}`
    );
  }

  // Check if token needs refresh
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - TOKEN_EXPIRY_BUFFER_MS) {
    if (!tokens.refresh_token) {
      throw new CliError(
        'TOKEN_EXPIRED',
        'Access token expired and no refresh token available',
        `Run: agentio ${service} profile add --profile ${profile}`
      );
    }

    const refreshed = await refreshTokens(service, profile, tokens);
    return { tokens: refreshed, profile };
  }

  return { tokens, profile };
}

async function refreshTokens(
  service: ServiceName,
  profileName: string,
  tokens: OAuthTokens
): Promise<OAuthTokens> {
  const oauth2Client = new OAuth2Client(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret
  );

  oauth2Client.setCredentials({
    refresh_token: tokens.refresh_token,
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    const newTokens: OAuthTokens = {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token || tokens.refresh_token,
      expiry_date: credentials.expiry_date || undefined,
      token_type: credentials.token_type || 'Bearer',
      scope: credentials.scope || tokens.scope,
    };

    await setCredentials(service, profileName, newTokens);
    return newTokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CliError(
      'TOKEN_EXPIRED',
      `Failed to refresh access token: ${message}`,
      `Run: agentio ${service} profile add --profile ${profileName}`
    );
  }
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
