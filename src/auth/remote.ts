import { CliError } from '../utils/errors';
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

let parsed: TokenParts | null = null;
let profilesPromise: Promise<ProfileRef[]> | null = null;

/** Forget the parsed token and the cached profile list (tests change the env). */
export function resetRemoteCache(): void {
  parsed = null;
  profilesPromise = null;
}

export function hub(): TokenParts {
  return (parsed ??= decodeToken(process.env.AGENTIO_TOKEN!));
}

/** Throw the one error every write path raises when there is no vault here. */
export function assertLocalMode(what: string): void {
  if (!isRemoteMode()) return;
  throw new CliError(
    'CONFIG_ERROR',
    `${what} is not available in remote mode`,
    `This machine uses the vault hub at ${hub().url}. Manage profiles and keys there.`,
  );
}

const REQUEST_TIMEOUT_MS = 15_000;

interface HubError {
  error?: string;
  code?: string;
  suggestion?: string;
}

/** The hub's HTTP failures as the CLI's own errors, with hub-specific advice. */
function hubError(status: number, body: HubError, url: string): CliError {
  const detail = body.error ?? `HTTP ${status}`;
  switch (status) {
    case 401:
      return new CliError('AUTH_FAILED', `The vault hub rejected this token: ${detail}`,
        'Get a new token from the hub admin UI, or `agentio key create` on the hub host');
    case 403:
      return new CliError('PERMISSION_DENIED', detail, 'Widen the key\'s scope on the hub, or use another key');
    case 404:
      return new CliError('PROFILE_NOT_FOUND', detail, 'Run: agentio profile list');
    case 409:
      return new CliError('AUTH_FAILED', `Re-authentication is needed on the vault host: ${detail}`,
        `Reauth the profile on the hub host, then retry`);
    case 429:
      return new CliError('RATE_LIMITED', detail);
    case 503:
      return new CliError('CONFIG_ERROR', 'The vault is locked on the hub', `Unlock it at ${url}/ui`);
    default:
      return new CliError('API_ERROR', `Vault hub error: ${detail}`);
  }
}

async function hubRequest<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const { url, secret: _secret } = hub();
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${process.env.AGENTIO_TOKEN!.trim()}` },
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
  if (!response.ok) throw hubError(response.status, (body ?? {}) as HubError, url);
  return { status: response.status, body: body as T };
}

/** The profiles this token may use, with the effective read-only flag. Fetched once per process. */
export function remoteProfiles(): Promise<ProfileRef[]> {
  return (profilesPromise ??= hubRequest<{ profiles: ProfileRef[] }>('/v1/profiles').then((r) => r.body.profiles).catch((err) => {
    profilesPromise = null;
    throw err;
  }));
}

/** Fresh credentials from the hub, in the shape the local code expects, or null when none are stored. */
export async function remoteCredentials<T = Record<string, unknown>>(service: ServiceName, name: string): Promise<T | null> {
  const path = `/v1/profiles/${encodeURIComponent(service)}/${encodeURIComponent(name)}/credentials`;
  try {
    const { body } = await hubRequest<{ credentials: T }>(path, { method: 'POST' });
    return body.credentials;
  } catch (err) {
    if (err instanceof CliError && err.code === 'PROFILE_NOT_FOUND') return null;
    throw err;
  }
}
