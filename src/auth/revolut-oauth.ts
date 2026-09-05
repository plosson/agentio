import { createSign } from 'crypto';
import { URL } from 'url';
import { CliError, httpStatusToErrorCode } from '../utils/errors';
import { apiBaseUrl } from '../types/revolut';
import type { RevolutCredentials, RevolutEnvironment } from '../types/revolut';

const CONSENT_BASE: Record<RevolutEnvironment, string> = {
  production: 'https://business.revolut.com/app-confirm',
  sandbox: 'https://sandbox-business.revolut.com/app-confirm',
};

const JWT_AUDIENCE = 'https://revolut.com';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_TTL_SEC = 60 * 60;

/**
 * Revolut derives the JWT `iss` claim from the host of the registered
 * OAuth redirect URI, not from the full URI.
 */
export function issuerFromRedirectUri(redirectUri: string): string {
  try {
    return new URL(redirectUri).hostname;
  } catch {
    throw new CliError(
      'INVALID_PARAMS',
      `Redirect URI "${redirectUri}" is not a valid URL`,
      'Use the full URI registered with Revolut, e.g. https://example.com/callback',
    );
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build the RS256 JWT that authenticates the client on every token request.
 * Signed with the private key whose certificate is uploaded to Revolut.
 */
export function createClientAssertion(credentials: Pick<RevolutCredentials, 'clientId' | 'privateKey' | 'redirectUri'>): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: issuerFromRedirectUri(credentials.redirectUri),
    sub: credentials.clientId,
    aud: JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + ASSERTION_TTL_SEC,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${base64url(signer.sign(credentials.privateKey))}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CliError(
      'AUTH_FAILED',
      `Failed to sign the client assertion: ${message}`,
      'Check the stored private key is a valid PEM matching the certificate uploaded to Revolut',
    );
  }
}

export function buildConsentUrl(
  params: { environment: RevolutEnvironment; clientId: string; redirectUri: string },
): string {
  const url = new URL(CONSENT_BASE[params.environment]);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

/**
 * Accept either a bare authorisation code or the full redirect URL the browser
 * landed on, so the user can paste whichever is easier to copy.
 */
export function extractAuthorizationCode(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new CliError('INVALID_PARAMS', 'Could not parse the pasted redirect URL');
    }

    const error = parsed.searchParams.get('error');
    if (error) {
      throw new CliError('AUTH_FAILED', `Revolut denied the authorisation: ${error}`);
    }

    const code = parsed.searchParams.get('code');
    if (!code) {
      throw new CliError(
        'INVALID_PARAMS',
        'No "code" parameter found in the pasted redirect URL',
        'Copy the full URL from the browser address bar after approving access',
      );
    }
    return code;
  }

  if (!trimmed) {
    throw new CliError('INVALID_PARAMS', 'Authorisation code is required');
  }

  return trimmed;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

async function postTokenRequest(environment: RevolutEnvironment, body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl(environment)}/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CliError('NETWORK_ERROR', `Could not reach the Revolut token endpoint: ${message}`);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new CliError(
      httpStatusToErrorCode(response.status),
      `Revolut token request failed (${response.status}): ${text}`,
      response.status === 401
        ? 'Check the client ID, the private key, and that the JWT issuer matches your registered redirect URI host'
        : undefined,
    );
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new CliError('API_ERROR', `Revolut returned an unexpected token response: ${text}`);
  }
}

export interface RevolutTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function exchangeCodeForTokens(
  code: string,
  credentials: Pick<RevolutCredentials, 'clientId' | 'privateKey' | 'redirectUri' | 'environment'>,
): Promise<RevolutTokenResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: credentials.clientId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: createClientAssertion(credentials),
  });

  const data = await postTokenRequest(credentials.environment, body);

  if (!data.refresh_token) {
    throw new CliError(
      'AUTH_FAILED',
      'Revolut did not return a refresh token',
      'Authorisation codes are single-use and expire within two minutes - request a fresh one',
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Revolut does not rotate refresh tokens, so the caller keeps the existing one.
 */
export async function refreshRevolutToken(
  credentials: Pick<RevolutCredentials, 'clientId' | 'privateKey' | 'redirectUri' | 'environment' | 'refreshToken'>,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: createClientAssertion(credentials),
  });

  const data = await postTokenRequest(credentials.environment, body);

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}
