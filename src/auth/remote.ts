import { existsSync, readFileSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join, relative } from 'path';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../utils/errors';
import { configDir } from '../vault/pointer';
import type { ServiceName } from '../types/config';
import type { ProfileRef } from '../config/config-manager';
import { decodeToken, type TokenParts } from './token';

/**
 * Remote mode: this machine has no vault. A token names a hub and a key, and
 * every profile or credential read becomes one HTTPS call. Writes are not
 * possible here; the hub owns the vault. A CLI process is short-lived, so the
 * profile list is fetched once and credentials once per profile touched.
 *
 * The token comes from AGENTIO_TOKEN, else from the file `agentio login`
 * writes. The env var wins so a script can override a stored login.
 */

export function tokenFilePath(): string {
  return join(configDir(), 'token');
}

let fileToken: string | null | undefined;

function readTokenFile(): string | null {
  try {
    return readFileSync(tokenFilePath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function remoteToken(): string | null {
  const env = process.env.AGENTIO_TOKEN?.trim();
  if (env) return env;
  return (fileToken ??= readTokenFile());
}

export function isRemoteMode(): boolean {
  return remoteToken() !== null;
}

/** Same guard as the vault: a test must never write to the real config directory. */
function assertWritablePath(path: string): void {
  if (process.env.NODE_ENV !== 'test') return;
  const rel = relative(tmpdir(), path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write a token outside ${tmpdir()} during tests: ${path}`);
  }
}

/** Store a token for this user, readable by them alone. */
export async function saveRemoteToken(token: string): Promise<string> {
  const path = tokenFilePath();
  assertWritablePath(path);
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, token + '\n', { mode: 0o600 });
  resetRemoteCache();
  return path;
}

/** Forget the stored token; false when there was none. */
export async function clearRemoteToken(): Promise<boolean> {
  const path = tokenFilePath();
  if (!existsSync(path)) return false;
  assertWritablePath(path);
  await unlink(path);
  resetRemoteCache();
  return true;
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
  fileToken = undefined;
}

export function hub(): TokenParts {
  return (parsed ??= decodeToken(remoteToken()!));
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
      headers: { Authorization: `Bearer ${remoteToken()!}` },
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
