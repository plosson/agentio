import { randomBytes } from 'crypto';
import { createPkcePair } from '../../auth/pkce';
import { CliError, redact } from '../../utils/errors';
import type { SetupContext } from '../../plugin-sdk';
import type { ChatGptCredentials, OpenAiTokens } from './types';

/**
 * ChatGPT sign-in, as `codex login` does it: OpenAI's public Codex client, PKCE, and the callback
 * OpenAI registered for it. Constants read from codex-cli 0.155.1.
 */
export const OPENAI_AUTH_URL = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_SCOPE = 'openid profile email offline_access';
const REFRESH_SCOPE = 'openid profile email';
const DEFAULT_LIFETIME_MS = 60 * 60_000;
const REAUTH = 'Run: agentio profile reauth chatgpt <profile>';
/** A first sign-in has no profile to reauthenticate. */
const SIGN_IN_AGAIN = 'Run: agentio chatgpt profile add --method chatgpt again';

export function buildAuthorizeUrl(params: { redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(`${OPENAI_AUTH_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', SIGN_IN_SCOPE);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', params.state);
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

async function postToken(body: string, contentType: string, secret: string, suggestion: string): Promise<OpenAiTokens> {
  let response: Response;
  try {
    response = await fetch(`${OPENAI_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new CliError('NETWORK_ERROR', 'Cannot reach auth.openai.com', 'Check your network and retry');
  }
  const text = await response.text().catch(() => '');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: the status alone decides.
  }
  if (response.ok) return data as OpenAiTokens;
  const detail = [data.error_description, data.error].find((v): v is string => typeof v === 'string');
  const reason = detail ? `: ${redact(detail, [secret], '[token]')}` : '';
  if (response.status === 400 || response.status === 401) {
    throw new CliError('AUTH_EXPIRED', `OpenAI refused the ChatGPT sign-in${reason}`, suggestion);
  }
  throw new CliError('API_ERROR', `auth.openai.com answered ${response.status}${reason}`);
}

export function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<OpenAiTokens> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CODEX_CLIENT_ID, code_verifier: verifier });
  return postToken(body.toString(), 'application/x-www-form-urlencoded', code, SIGN_IN_AGAIN);
}

export function refreshTokens(refreshToken: string): Promise<OpenAiTokens> {
  const body = JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: REFRESH_SCOPE });
  return postToken(body, 'application/json', refreshToken, REAUTH);
}

/** A JWT's payload, or {} when it is not one. The signature is OpenAI's business, not ours. */
function jwtPayload(token: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from((token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The vault's shape for `tokens`; `previous` supplies what a refresh may leave out. */
export function credentialsFromTokens(tokens: OpenAiTokens, previous?: ChatGptCredentials): ChatGptCredentials {
  if (!tokens.access_token) throw new CliError('API_ERROR', 'OpenAI answered without an access token');
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new CliError('API_ERROR', 'OpenAI answered without a refresh token');
  const idToken = tokens.id_token ?? previous?.idToken;
  const claims = jwtPayload(idToken);
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as { chatgpt_account_id?: unknown };
  const accountId = typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : previous?.accountId;
  if (!accountId) throw new CliError('API_ERROR', 'OpenAI\'s answer names no ChatGPT account');
  const exp = jwtPayload(tokens.access_token).exp;
  return {
    ...previous,
    kind: 'chatgpt',
    accessToken: tokens.access_token,
    refreshToken,
    idToken,
    accountId,
    email: typeof claims.email === 'string' ? claims.email : previous?.email,
    expiresAt: typeof exp === 'number' ? exp * 1000 : Date.now() + DEFAULT_LIFETIME_MS,
  };
}

/** The browser sign-in, through the host: the callback on port 1455 at /auth/callback. */
export async function signInWithChatGpt(context: SetupContext, model?: string): Promise<ChatGptCredentials> {
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString('hex');
  const { code, redirectUri } = await context.oauth({
    serviceName: 'ChatGPT',
    expectedState: state,
    port: CALLBACK_PORT,
    path: CALLBACK_PATH,
    authorizationUrl: (redirect) => buildAuthorizeUrl({ redirectUri: redirect, challenge, state }),
  });
  const credentials = credentialsFromTokens(await exchangeCode(code, verifier, redirectUri));
  return model ? { ...credentials, model } : credentials;
}
