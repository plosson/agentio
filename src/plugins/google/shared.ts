import { performOAuthFlow, type OAuthService } from './oauth';
import { createGoogleAuth, fetchGoogleUserEmail, refreshGoogleAccessToken } from './token-manager';
import type { GoogleCamelTokens, OAuthTokens } from './tokens';
import type { CredentialLifecycle, ProfilePlugin } from '../types';

export type GoogleSnakeCredentials = OAuthTokens & { email?: string };
export type GoogleCamelCredentials = GoogleCamelTokens & { email?: string };

export const googleSnakeCredentialLifecycle: CredentialLifecycle<OAuthTokens> = {
  secretFields: ['refresh_token'],
  applies: (credentials): credentials is OAuthTokens => typeof credentials === 'object'
    && credentials !== null
    && !!(credentials as Partial<OAuthTokens>).refresh_token,
  isStale: (credentials, now, bufferMs) => credentials.expiry_date !== undefined
    && now + bufferMs >= credentials.expiry_date,
  async refresh(credentials) {
    return { ...credentials, ...(await refreshGoogleAccessToken(credentials)) };
  },
};

export const googleCamelCredentialLifecycle: CredentialLifecycle<GoogleCamelTokens> = {
  secretFields: ['refreshToken'],
  applies: (credentials): credentials is GoogleCamelTokens => typeof credentials === 'object'
    && credentials !== null
    && !!(credentials as Partial<GoogleCamelTokens>).refreshToken,
  isStale: (credentials, now, bufferMs) => credentials.expiryDate !== undefined
    && now + bufferMs >= credentials.expiryDate,
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

export function googleAuthFromSnakeCredentials(tokens: OAuthTokens) {
  return createGoogleAuth({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope,
  });
}

export function reauthenticateGoogleSnake<TCredentials extends GoogleSnakeCredentials = GoogleSnakeCredentials>(
  service: OAuthService,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): NonNullable<ProfilePlugin<TCredentials>['reauthenticate']> {
  return async (credentials, profileName) => {
    console.error(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(service);
    const email = await fetchEmail(tokens.access_token);
    console.error(`  Done (${email})`);
    return { ...(credentials ?? {}), ...tokens, email } as TCredentials;
  };
}

export function reauthenticateGoogleCamel<TCredentials extends GoogleCamelCredentials>(
  service: OAuthService,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): NonNullable<ProfilePlugin<TCredentials>['reauthenticate']> {
  return async (credentials, profileName) => {
    console.error(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(service);
    const email = await fetchEmail(tokens.access_token);
    console.error(`  Done (${email})`);
    return {
      ...(credentials ?? {}),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      tokenType: tokens.token_type,
      scope: tokens.scope,
      email,
    } as TCredentials;
  };
}
