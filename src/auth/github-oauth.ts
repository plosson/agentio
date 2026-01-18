import { createServer, type Server } from 'http';
import { URL } from 'url';
import { GITHUB_OAUTH_CONFIG } from '../config/credentials';

const GITHUB_SCOPES = ['repo'];

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

export interface GitHubOAuthResult {
  accessToken: string;
}

export async function performGitHubOAuthFlow(): Promise<GitHubOAuthResult> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', GITHUB_OAUTH_CONFIG.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', GITHUB_SCOPES.join(' '));
  authUrl.searchParams.set('state', Math.random().toString(36).substring(7));

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
      const errorDescription = url.searchParams.get('error_description');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`GitHub OAuth error: ${error} - ${errorDescription || 'Unknown error'}`));
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
        // Exchange code for access token
        const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: GITHUB_OAUTH_CONFIG.clientId,
            client_secret: GITHUB_OAUTH_CONFIG.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });

        const tokenData = await tokenResponse.json() as {
          access_token?: string;
          error?: string;
          error_description?: string;
        };

        if (tokenData.error || !tokenData.access_token) {
          throw new Error(tokenData.error_description || tokenData.error || 'Failed to get access token');
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>');

        clearTimeout(timeout);
        server.close();

        resolve({
          accessToken: tokenData.access_token,
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
      console.error(`\nOpening browser for GitHub authorization...`);
      console.error(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);

      // Open browser
      const open = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';
      Bun.spawn([open, authUrl.toString()], { stdout: 'ignore', stderr: 'ignore' });
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      server?.close();
      reject(err);
    });
  });
}
