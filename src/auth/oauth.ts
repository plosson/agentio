import { createServer, type Server } from 'http';
import { URL } from 'url';
import { google } from 'googleapis';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import type { OAuthTokens } from '../types/tokens';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',  // search & read emails
  'https://www.googleapis.com/auth/gmail.send',      // send emails
  'https://www.googleapis.com/auth/gmail.compose',   // create/update drafts
];

const GCHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.messages.create',     // send messages
  'https://www.googleapis.com/auth/chat.messages.readonly',   // read messages (get operations)
  'https://www.googleapis.com/auth/chat.spaces.readonly',     // read space info and list
  'https://www.googleapis.com/auth/chat.memberships.readonly', // read space members
  'https://www.googleapis.com/auth/userinfo.email',           // get user email for profile naming
];

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;

async function findAvailablePort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.listen(port, () => {
          server.close(() => resolve());
        });
        server.on('error', reject);
      });
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`No available port found in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

export async function performOAuthFlow(
  service: 'gmail' | 'gchat'
): Promise<OAuthTokens> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret,
    redirectUri
  );

  const scopes = service === 'gmail' ? GMAIL_SCOPES : service === 'gchat' ? GCHAT_SCOPES : [];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  return new Promise((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing Authorization Code</h1><p>You can close this window.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error('Missing authorization code in OAuth callback'));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>');

        clearTimeout(timeout);
        server.close();

        resolve({
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || undefined,
          expiry_date: tokens.expiry_date || undefined,
          token_type: tokens.token_type || 'Bearer',
          scope: tokens.scope || undefined,
        });
      } catch (err) {
        res.writeHead(500);
        res.end('Failed to exchange authorization code');
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.error(`\nOpening browser for authorization...`);
      console.error(`If browser doesn't open, visit:\n${authUrl}\n`);

      // Open browser
      const open = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';
      Bun.spawn([open, authUrl], { stdout: 'ignore', stderr: 'ignore' });
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      server?.close();
      reject(err);
    });
  });
}
