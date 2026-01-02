import { google } from 'googleapis';
import { getTokens, setTokens } from './token-store';
import { getProfile } from '../config/config-manager';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import { CliError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function getValidTokens(
  service: ServiceName,
  profileName?: string
): Promise<{ tokens: OAuthTokens; profile: string }> {
  const profile = await getProfile(service, profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for ${service}`
        : `No default profile configured for ${service}`,
      `Run: allcli auth setup ${service}`
    );
  }

  const tokens = await getTokens(service, profile);

  if (!tokens) {
    throw new CliError(
      'AUTH_FAILED',
      `No tokens found for ${service} profile "${profile}"`,
      `Run: allcli auth setup ${service} --profile ${profile}`
    );
  }

  // Check if token needs refresh
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - TOKEN_EXPIRY_BUFFER_MS) {
    if (!tokens.refresh_token) {
      throw new CliError(
        'TOKEN_EXPIRED',
        'Access token expired and no refresh token available',
        `Run: allcli auth setup ${service} --profile ${profile}`
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
  const oauth2Client = new google.auth.OAuth2(
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

    await setTokens(service, profileName, newTokens);
    return newTokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CliError(
      'TOKEN_EXPIRED',
      `Failed to refresh access token: ${message}`,
      `Run: allcli auth setup ${service} --profile ${profileName}`
    );
  }
}

export function createGoogleAuth(tokens: OAuthTokens) {
  const oauth2Client = new google.auth.OAuth2(
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
