import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Find an available port in the range 3000-3010.
 */
export async function findAvailablePort(): Promise<number> {
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

/**
 * Launch the default browser to open a URL.
 */
export function launchBrowser(url: string): void {
  const open = process.platform === 'darwin' ? 'open' :
               process.platform === 'win32' ? 'start' : 'xdg-open';
  Bun.spawn([open, url], { stdout: 'ignore', stderr: 'ignore' });
}

/**
 * HTML templates for OAuth callback responses.
 */
export const OAuthHtml = {
  success: '<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>',
  failed: '<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>',
  missingCode: '<html><body><h1>Missing Authorization Code</h1><p>You can close this window.</p></body></html>',
  stateMismatch: '<html><body><h1>State Mismatch</h1><p>You can close this window.</p></body></html>',
};

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

export interface OAuthServerConfig {
  port: number;
  serviceName: string;
  expectedState?: string;
}

/**
 * Start an OAuth callback server that listens for the authorization code.
 *
 * @param config Configuration for the server
 * @returns Promise that resolves with the authorization code
 */
export function startOAuthCallbackServer(
  config: OAuthServerConfig
): Promise<OAuthCallbackResult> {
  const { port, serviceName, expectedState } = config;

  return new Promise((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out after 5 minutes'));
    }, TIMEOUT_MS);

    const handleCallback = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url || '', `http://localhost:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const returnedState = url.searchParams.get('state');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(OAuthHtml.failed);
        clearTimeout(timeout);
        server.close();
        const errorMsg = errorDescription ? `${error} - ${errorDescription}` : error;
        reject(new Error(`${serviceName} OAuth error: ${errorMsg}`));
        return;
      }

      if (expectedState && returnedState !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(OAuthHtml.stateMismatch);
        clearTimeout(timeout);
        server.close();
        reject(new Error('OAuth state mismatch - possible CSRF attack'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(OAuthHtml.missingCode);
        clearTimeout(timeout);
        server.close();
        reject(new Error('Missing authorization code in OAuth callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(OAuthHtml.success);
      clearTimeout(timeout);
      server.close();
      resolve({ code, state: returnedState || undefined });
    };

    server = createServer((req, res) => {
      handleCallback(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal server error');
        }
        clearTimeout(timeout);
        server?.close();
        reject(err);
      });
    });

    server.listen(port, () => {
      // Server is ready for callback
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      server?.close();
      reject(err);
    });
  });
}
