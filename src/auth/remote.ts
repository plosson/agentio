import { CliError, httpStatusToErrorCode, type ErrorCode } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { ProfileRef } from '../config/config-manager';
import { decodeToken, type TokenParts } from './token';

/**
 * Remote mode: this machine has no vault. AGENTIO_TOKEN names a hub and a key,
 * and every profile or credential read becomes one HTTPS call. Writes are not
 * possible here; the hub owns the vault. A CLI process is short-lived, so the
 * profile list is fetched once and credentials once per profile touched.
 */

export function isRemoteMode(): boolean {
  return Boolean(process.env.AGENTIO_TOKEN?.trim());
}

/** A profile as the hub lists it for this token. */
export interface RemoteProfile extends ProfileRef {
  readOnly: boolean;
  hasCredentials: boolean;
}

let parsed: TokenParts | null = null;
let profilesPromise: Promise<RemoteProfile[]> | null = null;

/** Forget the parsed token and the cached profile list (tests change the env). */
export function resetRemoteCache(): void {
  parsed = null;
  profilesPromise = null;
}

export function hub(): TokenParts {
  return (parsed ??= decodeToken(process.env.AGENTIO_TOKEN!));
}

/** The one error every owner-only path raises when there is no vault here. */
export function remoteModeError(what: string): CliError {
  return new CliError(
    'CONFIG_ERROR',
    `${what} is not available in remote mode`,
    `This machine uses the vault hub at ${hub().url}. Manage profiles and keys there.`,
  );
}

export function assertLocalMode(what: string): void {
  if (isRemoteMode()) throw remoteModeError(what);
}

const REQUEST_TIMEOUT_MS = 15_000;
const KNOWN_CODES = new Set<string>([
  'AUTH_FAILED', 'TOKEN_EXPIRED', 'PROFILE_NOT_FOUND', 'INVALID_PARAMS', 'API_ERROR', 'NETWORK_ERROR',
  'PERMISSION_DENIED', 'RATE_LIMITED', 'NOT_FOUND', 'CONFIG_ERROR', 'VAULT_NOT_CONFIGURED', 'VAULT_LOCKED', 'VAULT_CORRUPT',
]);

/**
 * The hub speaks this CLI's own error codes, so a failure keeps its code and
 * suggestion. Two are re-read for the agent's situation: a refresh the hub
 * could not do is an auth problem to fix on the hub, and a locked hub is
 * configuration, not a locked local vault. A non-JSON body (a proxy page) falls
 * back to the status.
 */
function hubError(status: number, body: { error?: string; code?: string; suggestion?: string }, url: string): CliError {
  const code: ErrorCode = body.code && KNOWN_CODES.has(body.code) ? (body.code as ErrorCode) : httpStatusToErrorCode(status);
  const detail = body.error ?? `HTTP ${status}`;
  switch (code) {
    case 'AUTH_FAILED':
      return new CliError('AUTH_FAILED', `The vault hub rejected this token: ${detail}`,
        'Get a new token from the hub admin UI, or `agentio key create` on the hub host');
    case 'TOKEN_EXPIRED':
      return new CliError('AUTH_FAILED', `Re-authentication is needed on the vault host: ${detail}`,
        'Reauth the profile on the hub host, then retry');
    case 'VAULT_LOCKED':
      return new CliError('CONFIG_ERROR', 'The vault is locked on the hub', `Unlock it at ${url}/ui`);
    default:
      return new CliError(code, detail, body.suggestion);
  }
}

async function hubRequest<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  const { url } = hub();
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.AGENTIO_TOKEN!.trim()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError('NETWORK_ERROR', `Cannot reach the vault hub at ${url}: ${reason}`,
      'Check the network, and that the hub daemon is running');
  }
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw hubError(response.status, (body ?? {}) as { error?: string; code?: string; suggestion?: string }, url);
  return body as T;
}

/** The profiles this token may use. Fetched once per process. */
export function remoteProfiles(): Promise<RemoteProfile[]> {
  return (profilesPromise ??= hubRequest<{ profiles: RemoteProfile[] }>('/v1/profiles').then((r) => r.profiles));
}

/** Fresh credentials from the hub, in the shape the local code expects, or null when none are stored. */
export async function remoteCredentials<T = Record<string, unknown>>(service: ServiceName, name: string): Promise<T | null> {
  const path = `/v1/profiles/${encodeURIComponent(service)}/${encodeURIComponent(name)}/credentials`;
  try {
    return (await hubRequest<{ credentials: T }>(path, 'POST')).credentials;
  } catch (err) {
    // NOT_FOUND is "profile exists, nothing stored"; an unknown profile stays PROFILE_NOT_FOUND.
    if (err instanceof CliError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}
