import { performOAuthFlow, type OAuthService } from './oauth';
import { createGoogleAuth, fetchGoogleUserEmail, refreshGoogleAccessToken } from './token-manager';
import type { GoogleCamelTokens, OAuthTokens } from '../../types/tokens';
import type { CredentialLifecycle, ProfilePlugin } from '../types';

type Reauthenticate = NonNullable<ProfilePlugin['reauthenticate']>;

function objectWith(credentials: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof credentials !== 'object' || credentials === null) return undefined;
  const record = credentials as Record<string, unknown>;
  return record[field] ? record : undefined;
}

function expiresSoon(credentials: unknown, field: string, now: number, bufferMs: number): boolean {
  if (typeof credentials !== 'object' || credentials === null) return false;
  const expiry = (credentials as Record<string, unknown>)[field];
  return typeof expiry === 'number' && now + bufferMs >= expiry;
}

export const googleSnakeCredentialLifecycle: CredentialLifecycle = {
  secretFields: ['refresh_token'],
  applies: (credentials) => !!objectWith(credentials, 'refresh_token'),
  isStale: (credentials, now, bufferMs) => expiresSoon(credentials, 'expiry_date', now, bufferMs),
  refresh: (credentials) => refreshGoogleAccessToken(credentials as OAuthTokens),
};

export const googleCamelCredentialLifecycle: CredentialLifecycle = {
  secretFields: ['refreshToken'],
  applies: (credentials) => !!objectWith(credentials, 'refreshToken'),
  isStale: (credentials, now, bufferMs) => expiresSoon(credentials, 'expiryDate', now, bufferMs),
  async refresh(credentials) {
    const current = credentials as GoogleCamelTokens;
    const refreshed = await refreshGoogleAccessToken({
      access_token: current.accessToken,
      refresh_token: current.refreshToken,
      expiry_date: current.expiryDate,
      token_type: current.tokenType,
      scope: current.scope,
    });
    return {
      ...current,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiryDate: refreshed.expiry_date,
      tokenType: refreshed.token_type,
      scope: refreshed.scope,
    };
  },
};

export function googleAuthFromSnakeCredentials(credentials: unknown) {
  const tokens = credentials as OAuthTokens;
  return createGoogleAuth({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope,
  });
}

export function reauthenticateGoogleSnake(
  service: OAuthService,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): Reauthenticate {
  return async (credentials, profileName) => {
    console.error(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(service);
    const email = await fetchEmail(tokens.access_token);
    console.error(`  Done (${email})`);
    return { ...(credentials as object), ...tokens, email };
  };
}

export function reauthenticateGoogleCamel(
  service: OAuthService,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): Reauthenticate {
  return async (credentials, profileName) => {
    console.error(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(service);
    const email = await fetchEmail(tokens.access_token);
    console.error(`  Done (${email})`);
    return {
      ...(credentials as object),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      tokenType: tokens.token_type,
      scope: tokens.scope,
      email,
    };
  };
}
