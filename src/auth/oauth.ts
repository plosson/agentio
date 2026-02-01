import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import { findAvailablePort, startOAuthCallbackServer, launchBrowser } from './oauth-server';
import type { OAuthTokens } from '../types/tokens';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',  // search & read emails
  'https://www.googleapis.com/auth/gmail.send',      // send emails
  'https://www.googleapis.com/auth/gmail.compose',   // create/update drafts
  'https://www.googleapis.com/auth/userinfo.email',  // get email for profile naming
];

const GCHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.messages.create',     // send messages
  'https://www.googleapis.com/auth/chat.messages.readonly',   // read messages (get operations)
  'https://www.googleapis.com/auth/chat.spaces.readonly',     // read space info and list
  'https://www.googleapis.com/auth/chat.memberships.readonly', // read space members
  'https://www.googleapis.com/auth/userinfo.email',           // get user email for profile naming
];

const GDOCS_SCOPES = [
  'https://www.googleapis.com/auth/documents',          // read/write docs
  'https://www.googleapis.com/auth/drive.file',         // create/access files created by this app
  'https://www.googleapis.com/auth/drive.readonly',     // read all drive files (list, metadata, export)
  'https://www.googleapis.com/auth/userinfo.email',     // get email for profile naming
];

const GDRIVE_READONLY_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',     // read all drive files (list, metadata, download)
  'https://www.googleapis.com/auth/userinfo.email',     // get email for profile naming
];

const GDRIVE_FULL_SCOPES = [
  'https://www.googleapis.com/auth/drive',              // full access to all drive files
  'https://www.googleapis.com/auth/userinfo.email',     // get email for profile naming
];

const GCAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar',           // full access to calendars
  'https://www.googleapis.com/auth/userinfo.email',     // get email for profile naming
];

const GTASKS_SCOPES = [
  'https://www.googleapis.com/auth/tasks',              // full access to tasks
  'https://www.googleapis.com/auth/userinfo.email',     // get email for profile naming
];

const GSHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',       // full access to spreadsheets
  'https://www.googleapis.com/auth/drive.file',         // create/access files created by this app
  'https://www.googleapis.com/auth/drive.readonly',     // list spreadsheets, export, copy
  'https://www.googleapis.com/auth/userinfo.email',     // get email for profile naming
];

const SCOPES: Record<'gmail' | 'gchat' | 'gdocs' | 'gdrive-readonly' | 'gdrive-full' | 'gcal' | 'gtasks' | 'gsheets', string[]> = {
  gmail: GMAIL_SCOPES,
  gchat: GCHAT_SCOPES,
  gdocs: GDOCS_SCOPES,
  'gdrive-readonly': GDRIVE_READONLY_SCOPES,
  'gdrive-full': GDRIVE_FULL_SCOPES,
  gcal: GCAL_SCOPES,
  gtasks: GTASKS_SCOPES,
  gsheets: GSHEETS_SCOPES,
};

export type OAuthService = 'gmail' | 'gchat' | 'gdocs' | 'gdrive-readonly' | 'gdrive-full' | 'gcal' | 'gtasks' | 'gsheets';

export async function performOAuthFlow(
  service: OAuthService
): Promise<OAuthTokens> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const oauth2Client = new OAuth2Client(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret,
    redirectUri
  );

  const scopes = SCOPES[service];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  // Start callback server and browser in parallel
  const callbackPromise = startOAuthCallbackServer({
    port,
    serviceName: 'Google',
  });

  console.error(`\nOpening browser for authorization...`);
  console.error(`If browser doesn't open, visit:\n${authUrl}\n`);
  launchBrowser(authUrl);

  // Wait for the callback with the authorization code
  const { code } = await callbackPromise;

  // Exchange code for tokens using Google's OAuth client
  const { tokens } = await oauth2Client.getToken(code);

  return {
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope || undefined,
  };
}
