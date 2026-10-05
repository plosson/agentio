import { performOAuthFlow, type OAuthService } from './oauth';
import { createGoogleAuth, fetchGoogleUserEmail, refreshGoogleAccessToken } from './token-manager';
import type { GoogleCamelTokens, OAuthTokens } from './tokens';
import type { CredentialLifecycle, ProfileAddOptions, ProfilePlugin } from '../types';
import type { SetupContext, SetupResult } from '../../plugin-sdk';
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

export function reauthenticateGoogleSnake<TCredentials extends GoogleSnakeCredentials = GoogleSnakeCredentials>(
  service: OAuthService,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): NonNullable<ProfilePlugin<TCredentials>['reauthenticate']> {
  return async (credentials, profileName, context) => {
    context.log(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(service, context);
    const email = await fetchEmail(tokens.access_token);
    context.log(`  Done (${email})`);
    return { ...(credentials ?? {}), ...tokens, email } as TCredentials;
  };
}

export function reauthenticateGoogleCamel<TCredentials extends GoogleCamelCredentials>(
  service: OAuthService,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): NonNullable<ProfilePlugin<TCredentials>['reauthenticate']> {
  return async (credentials, profileName, context) => {
    context.log(`\nRe-authenticating ${service} / ${profileName}...`);
    const tokens = await performOAuth(service, context);
    const email = await fetchEmail(tokens.access_token);
    context.log(`  Done (${email})`);
    return {
      ...(credentials ?? {}),
      ...toCamelTokens(tokens),
      email,
    } as TCredentials;
  };
}

/** Sign in to Google for `service` in the browser; the tokens and the account's email. */
export async function signInToGoogle(
  service: OAuthService,
  context: SetupContext,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
): Promise<{ tokens: OAuthTokens; email: string }> {
  const tokens = await performOAuth(service, context);
  try {
    return { tokens, email: await fetchEmail(tokens.access_token) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError('AUTH_FAILED', `Could not read the Google account's email: ${reason}`, 'Try again, or pass --profile');
  }
}

/** Google's tokens in the camelCase shape gdocs, gsheets, gslides, gscript, gdrive and gchat store. */
export function toCamelTokens(tokens: OAuthTokens): GoogleCamelTokens {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
  };
}

/** `profile.setup` for a service that stores Google's tokens as they come (gmail, gcal, gtasks). */
export function googleSnakeSetup(
  service: OAuthService,
  testCommand: string,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
) {
  return async (_options: ProfileAddOptions, context: SetupContext): Promise<SetupResult<OAuthTokens & { email: string }>> => {
    context.log(`Signing in to Google for ${service}...\n`);
    const { tokens, email } = await signInToGoogle(service, context, performOAuth, fetchEmail);
    return { credentials: { ...tokens, email }, suggestedProfileName: email, info: `Email: ${email}\nTest with: ${testCommand}` };
  };
}

/** `profile.setup` for a service that stores them camelCase (gdocs, gsheets, gslides, gscript). */
export function googleCamelSetup(
  service: OAuthService,
  testCommand: string,
  performOAuth: typeof performOAuthFlow = performOAuthFlow,
  fetchEmail: typeof fetchGoogleUserEmail = fetchGoogleUserEmail,
) {
  return async (_options: ProfileAddOptions, context: SetupContext): Promise<SetupResult<GoogleCamelTokens & { email: string }>> => {
    context.log(`Signing in to Google for ${service}...\n`);
    const { tokens, email } = await signInToGoogle(service, context, performOAuth, fetchEmail);
    return { credentials: { ...toCamelTokens(tokens), email }, suggestedProfileName: email, info: `Email: ${email}\nTest with: ${testCommand}` };
  };
}
