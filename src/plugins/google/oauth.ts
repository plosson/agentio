import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import { findAvailablePort, awaitOAuthCode } from '../../auth/oauth-server';
import type { OAuthTokens } from './tokens';

const SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gchat: [
    'https://www.googleapis.com/auth/chat.messages.create',
    'https://www.googleapis.com/auth/chat.messages.readonly',
    'https://www.googleapis.com/auth/chat.spaces.readonly',
    'https://www.googleapis.com/auth/chat.memberships.readonly',
    'https://www.googleapis.com/auth/directory.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gdocs: [
    'https://www.googleapis.com/auth/documents',
    // Full drive, not drive.file: `gdocs update` rewrites docs agentio did not create.
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  'gdrive-readonly': [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  'gdrive-full': [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gcal: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gtasks: [
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gsheets: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gslides: [
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  gscript: [
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
} as const;

export type OAuthService = keyof typeof SCOPES;

/** A broader scope Google may grant that covers a narrower one we asked for. */
const COVERED_BY: Record<string, string> = {
  'https://www.googleapis.com/auth/drive.readonly': 'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file': 'https://www.googleapis.com/auth/drive',
};

/** Every scope the keys need, each once, in the order first seen. */
export function scopesFor(keys: readonly OAuthService[]): string[] {
  return [...new Set(keys.flatMap((key) => SCOPES[key]))];
}

/** The scopes the keys need that Google's space-separated answer does not grant. */
export function missingScopes(keys: readonly OAuthService[], granted: string | undefined): string[] {
  const have = new Set((granted ?? '').split(/\s+/).filter(Boolean));
  return scopesFor(keys).filter((scope) => !have.has(scope) && !have.has(COVERED_BY[scope] ?? ''));
}

export async function performOAuthFlow(keys: OAuthService | readonly OAuthService[]): Promise<OAuthTokens> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;
  const oauth2Client = new OAuth2Client(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret,
    redirectUri,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopesFor(typeof keys === 'string' ? [keys] : keys),
    prompt: 'consent',
  });
  const { code } = await awaitOAuthCode({
    port,
    serviceName: 'Google',
    authUrl,
  });
  const { tokens } = await oauth2Client.getToken(code);

  return {
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope || undefined,
  };
}
