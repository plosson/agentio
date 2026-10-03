import { performOAuthFlow } from './oauth';
import { suiteEntry, type StoredGoogleCredentials } from './suite';
import { createGoogleAuth, fetchGoogleUserEmail, refreshGoogleAccessToken } from './token-manager';
import type { GoogleCamelTokens, OAuthTokens } from './tokens';
import type { CredentialLifecycle, ProfilePlugin } from '../types';
import { CliError } from '../../utils/errors';

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

/** A consent made with another Google account than the one the profile holds. */
export function assertSameAccount(expected: unknown, actual: string): void {
  if (typeof expected !== 'string' || !expected) return;
  if (expected.toLowerCase() === actual.toLowerCase()) return;
  throw new CliError(
    'AUTH_FAILED',
    `Signed in as ${actual}, but this profile belongs to ${expected}`,
    `Run the command again and choose ${expected} in the browser`,
  );
}

/** Renew one Google profile: its own scopes, the same account, and the fields it already had. */
export function reauthenticateGoogle<TCredentials extends object>(
  service: string,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): NonNullable<ProfilePlugin<TCredentials>['reauthenticate']> {
  const entry = suiteEntry(service);
  if (!entry) throw new Error(`${service} is not a Google suite service`);
  return async (credentials, profileName) => {
    const existing = (credentials ?? {}) as StoredGoogleCredentials;
    console.error(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(entry.scopeKey({ existing }));
    const email = await fetchEmail(tokens.access_token);
    assertSameAccount(existing.email, email);
    console.error(`  Done (${email})`);
    return entry.toCredentials(tokens, email, { existing }) as unknown as TCredentials;
  };
}
