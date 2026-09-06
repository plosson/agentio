import { createHash, randomBytes } from 'crypto';
import { URL } from 'url';
import { CliError, httpStatusToErrorCode } from '../utils/errors';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/**
 * Scopes requested at authorisation time. Each one must also be enabled on the
 * Permissions tab of the app in the Dropbox App Console, otherwise Dropbox
 * rejects the authorisation URL.
 */
export const DROPBOX_SCOPES = [
  'account_info.read',    // identify the account behind the profile
  'files.metadata.read',  // list, get, search
  'files.content.read',   // download
  'files.content.write',  // upload, mkdir, move, copy, delete
  'sharing.read',         // read existing shared links
  'sharing.write',        // create shared links
];

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Built without a redirect URI on purpose: Dropbox then renders the
 * authorisation code in the browser for the user to copy, so the app needs no
 * registered redirect URI and no local callback server.
 */
export function buildAuthorizeUrl(appKey: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', appKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline'); // ask for a refresh token
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', DROPBOX_SCOPES.join(' '));
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  account_id?: string;
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
    throw new CliError('NETWORK_ERROR', `Could not reach the Dropbox token endpoint: ${message}`);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new CliError(
      httpStatusToErrorCode(response.status),
      `Dropbox token request failed (${response.status}): ${text}`,
      response.status === 400
        ? 'Authorisation codes are single-use and short-lived - request a fresh one'
        : undefined,
    );
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new CliError('API_ERROR', `Dropbox returned an unexpected token response: ${text}`);
  }
}

export interface DropboxTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accountId?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  appKey: string,
  codeVerifier: string,
): Promise<DropboxTokenResult> {
  const data = await postTokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: appKey,
      code_verifier: codeVerifier,
    }),
  );

  if (!data.refresh_token) {
    throw new CliError(
      'AUTH_FAILED',
      'Dropbox did not return a refresh token',
      'The authorisation URL must include token_access_type=offline - retry: agentio dropbox profile add',
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    accountId: data.account_id,
  };
}

/**
 * Dropbox does not rotate refresh tokens, so the caller keeps the existing one.
 */
export async function refreshDropboxToken(
  appKey: string,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await postTokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: appKey,
    }),
  );

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}
