import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { createInterface } from 'readline';
import { URL } from 'url';
import { CliError } from '../utils/errors';
import { whichOnPath } from '../utils/external-cli';

/** Where the local sign-in server listens for the provider's redirect. */
export const DEFAULT_CALLBACK_PATH = '/callback';

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** A sign-in that did not complete, with a code a program can act on. */
const signInFailed = (message: string) => new CliError('AUTH_FAILED', message, 'Run the command again and approve access in the browser');

/**
 * Find an available port in the range 3000-3010.
 */
export async function findAvailablePort(host?: string): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        const onListen = () => {
          server.close(() => resolve());
        };
        if (host) server.listen(port, host, onListen);
        else server.listen(port, onListen);
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
 * Open the default browser, best effort.
 *
 * A headless box has no opener at all - `xdg-open` is absent over SSH. That
 * must not take the OAuth flow down with it: the URL has already been printed,
 * and the caller can still finish the flow by hand.
 *
 * `start` on Windows is a shell builtin rather than an executable, so it has to
 * go through cmd. The empty argument after it is the window title, which cmd
 * would otherwise take from a quoted URL.
 *
 * @returns whether an opener was actually spawned
 */
export function launchBrowser(url: string): boolean {
  const command = process.platform === 'darwin' ? ['open', url] :
                  process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] :
                  ['xdg-open', url];

  // A missing opener throws synchronously on macOS but not on Linux, where the
  // child simply fails to exec; resolving it on PATH first behaves the same on
  // both. PATH is passed explicitly so a runtime change to it (tests) is seen.
  if (!whichOnPath(command[0])) return false;
  try {
    Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
  /** Bind address. Spotify requires 127.0.0.1 (not localhost). */
  host?: string;
  /** The path the code comes back on; default /callback. */
  path?: string;
  /** Closes the server when the code arrived some other way. */
  signal?: AbortSignal;
}

/** The code to come, and `listening`, settled once the server listens or fails to. */
export type OAuthCallbackServer = Promise<OAuthCallbackResult> & { listening: Promise<void> };

/**
 * Start an OAuth callback server that listens for the authorization code.
 *
 * @param config Configuration for the server
 * @returns Promise that resolves with the authorization code
 */
export function startOAuthCallbackServer(
  config: OAuthServerConfig
): OAuthCallbackServer {
  const { port, serviceName, expectedState, host, path = DEFAULT_CALLBACK_PATH } = config;
  let listened!: () => void;
  let notListening!: (error: unknown) => void;
  const listening = new Promise<void>((resolve, reject) => {
    listened = resolve;
    notListening = reject;
  });

  const result = new Promise<OAuthCallbackResult>((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(signInFailed('OAuth flow timed out after 5 minutes'));
    }, TIMEOUT_MS);

    const handleCallback = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const url = new URL(req.url || '', `http://${host ?? 'localhost'}:${port}`);

      if (url.pathname !== path) {
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
        reject(signInFailed(`${serviceName} OAuth error: ${errorMsg}`));
        return;
      }

      if (expectedState && returnedState !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(OAuthHtml.stateMismatch);
        clearTimeout(timeout);
        server.close();
        reject(signInFailed('OAuth state mismatch - possible CSRF attack'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(OAuthHtml.missingCode);
        clearTimeout(timeout);
        server.close();
        reject(signInFailed('Missing authorization code in OAuth callback'));
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

    if (host) server.listen(port, host, listened);
    else server.listen(port, listened);

    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      server?.close();
      const shownHost = host ?? 'localhost';
      const error = err.code === 'EADDRINUSE'
        ? new CliError(
          'CONFIG_ERROR',
          `${serviceName} sign-in needs port ${port} on ${shownHost}, and another program is using it`,
          `Stop the program using ${shownHost}:${port}, then try again`,
        )
        : err;
      notListening(error);
      reject(error);
    });

    // The code can also arrive by hand. Shut the server down so the process can
    // exit, and leave the promise unsettled - the race has already been decided.
    config.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        server?.close();
      },
      { once: true },
    );
  });

  // A server that never listened fails both promises with the same error: the caller that awaited
  // `listening` has it, so the code's rejection must not also be reported as unhandled.
  listening.catch(() => { result.catch(() => {}); });
  return Object.assign(result, { listening });
}

/**
 * Read an authorization code out of a pasted redirect URL, or accept a bare code.
 */
export function parseOAuthRedirect(
  input: string,
  serviceName: string,
  expectedState?: string,
): OAuthCallbackResult {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new CliError('INVALID_PARAMS', 'An authorization code is required');
  }

  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return { code: trimmed };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliError(
      'INVALID_PARAMS',
      'Could not parse the pasted redirect URL',
      'Copy the whole address bar, starting with http://',
    );
  }

  const error = parsed.searchParams.get('error');
  if (error) {
    const description = parsed.searchParams.get('error_description');
    throw new CliError(
      'AUTH_FAILED',
      `${serviceName} denied the authorization: ${description ? `${error} - ${description}` : error}`,
    );
  }

  const returnedState = parsed.searchParams.get('state');
  if (expectedState && returnedState !== expectedState) {
    throw new CliError('AUTH_FAILED', 'OAuth state mismatch - possible CSRF attack');
  }

  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new CliError(
      'INVALID_PARAMS',
      'No "code" parameter found in the pasted redirect URL',
      'Copy the full URL from the browser address bar after approving access',
    );
  }

  return { code, state: returnedState || undefined };
}

/**
 * Prompt for a pasted redirect URL, cancellably.
 *
 * The returned promise stays unsettled if cancelled: the caller has already
 * taken the code from the callback server and only needs stdin released.
 */
function readPastedRedirect(): { promise: Promise<string>; cancel: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const promise = new Promise<string>((resolve) => {
    rl.question('? Redirect URL (or code): ', (answer) => {
      rl.close();
      resolve(answer);
    });
  });

  return {
    promise,
    cancel: () => {
      rl.close();
      process.stdin.pause();
    },
  };
}

export interface AwaitOAuthCodeConfig extends Omit<OAuthServerConfig, 'signal'> {
  authUrl: string;
}

/**
 * Get the authorization code back from the user, whichever way it can reach us.
 *
 * On a desktop the browser opens and the callback server picks the code up with
 * no interaction. Over SSH neither half of that works: there may be no opener at
 * all, and the redirect points at the *remote* host's localhost, which the
 * browser on the user's laptop cannot reach. So the pasted address bar is
 * accepted in parallel, and whichever arrives first wins.
 */
export async function awaitOAuthCode(config: AwaitOAuthCodeConfig): Promise<OAuthCallbackResult> {
  const { authUrl, serviceName, expectedState } = config;

  const controller = new AbortController();
  const callbackPromise = startOAuthCallbackServer({ ...config, signal: controller.signal });
  // A busy port fails here, before a browser opens or stdin is read.
  await callbackPromise.listening;

  console.error(`\nOpening browser for ${serviceName} authorization...`);
  console.error(`If the browser doesn't open, visit:\n${authUrl}\n`);

  if (!launchBrowser(authUrl)) {
    console.error('No browser could be opened on this machine.\n');
  }

  console.error('Waiting for the browser to come back.');
  console.error('On a remote machine the redirect lands on this host and your browser cannot');
  console.error('reach it - approve access anyway, then paste the address bar contents here.\n');

  const pasted = readPastedRedirect();

  try {
    const result = await Promise.race([
      callbackPromise,
      pasted.promise.then((answer) => parseOAuthRedirect(answer, serviceName, expectedState)),
    ]);
    return result;
  } finally {
    controller.abort();
    pasted.cancel();
  }
}
