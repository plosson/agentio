import { CliError } from '../../utils/errors';
import { AUTH_URL, BRAND, LOGIN_SCOPES, REFRESH_SCOPES } from './types';

export interface FalcoTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export type FalcoLoginResult =
  | { type: 'success'; tokens: FalcoTokens }
  | { type: 'two_factor_required' };

interface RawTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
}

/**
 * Accept a token payload only when every field we persist is present. A blind
 * cast here would store an undefined refresh token and a NaN expiry, which
 * disables refresh permanently and silently.
 */
function requireTokens(raw: Partial<RawTokens>): FalcoTokens {
  const missing = (['access_token', 'refresh_token', 'expires_in', 'refresh_token_expires_in'] as const).filter(
    (field) => raw[field] === undefined || raw[field] === null,
  );
  if (missing.length > 0) {
    throw new CliError(
      'API_ERROR',
      `Falco returned an incomplete token response (missing ${missing.join(', ')})`,
      'Retry; if it persists the auth API has changed',
    );
  }
  return {
    accessToken: raw.access_token!,
    refreshToken: raw.refresh_token!,
    expiresIn: raw.expires_in!,
    refreshTokenExpiresIn: raw.refresh_token_expires_in!,
  };
}

/**
 * Password login, optionally with a 2FA code. Falco reports a missing second
 * factor as an error body rather than a distinct status, so the caller prompts
 * for the code and calls again.
 */
export async function loginToFalco(params: {
  username: string;
  password: string;
  twoFaCode?: string;
}): Promise<FalcoLoginResult> {
  let response: Response;
  try {
    response = await fetch(`${AUTH_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        userName: params.username,
        password: params.password,
        twoFaCode: params.twoFaCode ?? null,
        brand: BRAND,
        impersonate: null,
        scopes: LOGIN_SCOPES,
      }),
    });
  } catch (error) {
    throw new CliError(
      'NETWORK_ERROR',
      `Could not reach Falco: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  if (response.ok) {
    try {
      // Never echo this body: on success it is the token payload itself.
      return { type: 'success', tokens: requireTokens(JSON.parse(text) as Partial<RawTokens>) };
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'API_ERROR',
        'Falco returned a login response that could not be read',
        'Retry; if it persists the login API has changed',
      );
    }
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Fall through to the generic error below.
  }
  if (parsed.error === 'two_factor_required') return { type: 'two_factor_required' };
  if (parsed.error === 'invalid_credentials') {
    throw new CliError('AUTH_FAILED', 'Invalid Falco credentials', 'Check the email and password');
  }
  if (parsed.error === 'invalid_two_factor_code') {
    throw new CliError(
      'AUTH_FAILED',
      'Falco rejected the two-factor code',
      'Codes expire quickly. Re-run the command and enter a fresh one.',
    );
  }
  throw new CliError('AUTH_FAILED', `Falco login failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
}

/**
 * Exchange a refresh token for a new pair. The token rotates, so the result
 * must be persisted or the old one is lost. Note the scope list is narrower
 * than login's — that is what the desktop app sends, reproduced verbatim.
 */
export async function refreshFalcoToken(refreshToken: string): Promise<FalcoTokens> {
  const form = new FormData();
  form.append('grant_type', 'refresh_token');
  form.append('scope', REFRESH_SCOPES.join(' '));
  form.append('refresh_token', refreshToken);

  let response: Response;
  try {
    response = await fetch(`${AUTH_URL}/oauth2/token`, { method: 'POST', body: form });
  } catch (error) {
    throw new CliError(
      'NETWORK_ERROR',
      `Could not reach Falco: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new CliError(
      'TOKEN_EXPIRED',
      `Falco refresh failed (HTTP ${response.status}): ${details.slice(0, 200)}`,
      'Run: agentio reauth',
    );
  }
  return requireTokens((await response.json()) as Partial<RawTokens>);
}

/** Best-effort revocation; Falco does not report a useful failure here. */
export async function revokeFalcoToken(refreshToken: string): Promise<void> {
  try {
    await fetch(`${AUTH_URL}/revoke-refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ RefreshToken: refreshToken }),
    });
  } catch {
    // Revocation is advisory; the local credentials are gone either way.
  }
}
