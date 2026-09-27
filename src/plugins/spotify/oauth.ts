import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import {
  awaitOAuthCode,
  launchBrowser,
  parseOAuthRedirect,
} from '../../auth/oauth-server';
import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import { prompt } from '../../utils/stdin';
import {
  AUTHORIZE_URL,
  LOOPBACK_HOST,
  REDIRECT_PATH,
  SPOTIFY_READ_SCOPES,
  SPOTIFY_WRITE_SCOPES,
  TOKEN_URL,
} from './types';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function scopesFor(readOnly: boolean): string[] {
  return readOnly
    ? [...SPOTIFY_READ_SCOPES]
    : [...SPOTIFY_READ_SCOPES, ...SPOTIFY_WRITE_SCOPES];
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', params.scopes.join(' '));
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CliError('NETWORK_ERROR', `Could not reach the Spotify token endpoint: ${message}`);
  }

  const text = await response.text();
  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    throw new CliError(
      httpStatusToErrorCode(response.status),
      `Spotify token request failed (${response.status}): ${text}`,
    );
  }

  if (!response.ok || data.error) {
    const desc = data.error_description || data.error || text;
    if (data.error === 'invalid_grant' || /invalid_grant/i.test(desc)) {
      throw new CliError(
        'AUTH_EXPIRED',
        'Spotify sign-in has expired (Spotify requires signing in again every 6 months).',
        'Re-authenticate with: agentio profile reauth spotify',
      );
    }
    throw new CliError(
      httpStatusToErrorCode(response.status),
      `Spotify token request failed (${response.status}): ${desc}`,
      response.status === 400
        ? 'Authorisation codes are single-use and short-lived — request a fresh one'
        : undefined,
    );
  }

  return data;
}

export interface SpotifyTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<SpotifyTokenResult> {
  const data = await postTokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  );

  if (!data.refresh_token) {
    throw new CliError(
      'AUTH_FAILED',
      'Spotify did not return a refresh token',
      'Retry: agentio spotify profile add',
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
  };
}

/**
 * Refresh with client_id only (PKCE apps have no secret).
 * Spotify may rotate the refresh token — callers must store it when present.
 */
export async function refreshSpotifyToken(
  clientId: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string; scopes?: string[] }> {
  const data = await postTokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  );

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token,
    scopes: data.scope ? data.scope.split(' ').filter(Boolean) : undefined,
  };
}

export const SPOTIFY_OAUTH_PORT = 3010;
export const SPOTIFY_REDIRECT_URI = `http://${LOOPBACK_HOST}:${SPOTIFY_OAUTH_PORT}${REDIRECT_PATH}`;

export interface AuthorizeOptions {
  clientId: string;
  readOnly: boolean;
  noBrowser?: boolean;
}

export async function authorizeSpotify(options: AuthorizeOptions): Promise<SpotifyTokenResult> {
  const scopes = scopesFor(options.readOnly);
  const port = SPOTIFY_OAUTH_PORT;
  const redirectUri = SPOTIFY_REDIRECT_URI;
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString('hex');
  const authUrl = buildAuthorizeUrl({
    clientId: options.clientId,
    redirectUri,
    challenge,
    state,
    scopes,
  });

  let code: string;

  if (options.noBrowser) {
    console.error('\nOpen this URL in a browser on any machine:\n');
    console.error(`  ${authUrl}\n`);
    console.error('After approving, the browser is redirected to a 127.0.0.1 address that may fail to load.');
    console.error('Copy the full address bar contents and paste them here.\n');
    const pasted = await prompt('? Paste the redirect URL (or just the code): ');
    ({ code } = parseOAuthRedirect(pasted, 'Spotify', state));
  } else {
    try {
      const result = await awaitOAuthCode({
        port,
        host: LOOPBACK_HOST,
        serviceName: 'Spotify',
        expectedState: state,
        authUrl,
      });
      code = result.code;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new CliError(
          'CONFIG_ERROR',
          `Spotify OAuth callback port ${SPOTIFY_OAUTH_PORT} is already in use.`,
          `Stop the process using ${LOOPBACK_HOST}:${SPOTIFY_OAUTH_PORT} and try again.`,
        );
      }
      throw error;
    }
  }

  return exchangeCodeForTokens(code, options.clientId, verifier, redirectUri);
}

export const SPOTIFY_APP_SETUP_STEPS = `
Create a Spotify app (Development Mode; Premium required for the app owner):

  1. Go to https://developer.spotify.com/dashboard and click Create app.
  2. Under Redirect URIs, add http://127.0.0.1:3010/callback exactly.
  3. Under Which API/SDKs are you planning to use, select Web API.
  4. Copy the Client ID. agentio does not need the client secret.
  5. To let another person use the app, add their Spotify email under User Management (max 5).
`.trim();

export function printAppSetupSteps(): void {
  console.error(`\n${SPOTIFY_APP_SETUP_STEPS}\n`);
}

/** Re-export for lifecycle reauth that still wants to open a browser. */
export { launchBrowser };
