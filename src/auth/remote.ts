import { existsSync, readFileSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { cannotManageProfilesError, CliError, httpStatusToErrorCode, type ErrorCode } from '../utils/errors';
import { assertTestWritable, configDir } from '../vault/pointer';
import type { ServiceName } from '../types/config';
import type { ProfileRef, SetProfileOptions } from '../config/config-manager';
import type { WriteOutcome } from '../config/profile-store';
import { decodeToken, type TokenParts } from './token';

/**
 * Remote mode: this machine has no vault. A token names a hub and a key, and
 * every profile or credential read becomes one HTTPS call. The hub owns the
 * vault; the single write from here is `remoteAddProfile`. A CLI process is
 * short-lived, so the listing is fetched once and credentials once per
 * profile touched.
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

/** Where the token comes from, so commands can say so; null in local mode. */
export function tokenSource(): 'env' | 'file' | null {
  if (process.env.AGENTIO_TOKEN?.trim()) return 'env';
  if (fileToken === undefined) fileToken = readTokenFile();
  return fileToken === null ? null : 'file';
}

export function remoteToken(): string | null {
  switch (tokenSource()) {
    case 'env': return process.env.AGENTIO_TOKEN!.trim();
    case 'file': return fileToken!;
    default: return null;
  }
}

export function isRemoteMode(): boolean {
  return tokenSource() !== null;
}

/** Store a token for this user, readable by them alone. */
export async function saveRemoteToken(token: string): Promise<string> {
  const path = tokenFilePath();
  assertTestWritable(path, 'token');
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, token + '\n', { mode: 0o600 });
  resetRemoteCache();
  return path;
}

/** Forget the stored token; false when there was none. */
export async function clearRemoteToken(): Promise<boolean> {
  const path = tokenFilePath();
  if (!existsSync(path)) return false;
  assertTestWritable(path, 'token');
  await unlink(path);
  resetRemoteCache();
  return true;
}

/** A profile as the hub lists it for this token. */
export interface RemoteProfile extends ProfileRef {
  readOnly: boolean;
  hasCredentials: boolean;
}

/** What `GET /v1/profiles` answers: the key's view of the vault, plus its own add right. */
interface RemoteListing {
  profiles: RemoteProfile[];
  /** Absent from a hub older than the right, which is not the same as a key that lacks it. */
  canManageProfiles?: boolean;
}

let parsed: TokenParts | null = null;
let listingPromise: Promise<RemoteListing> | null = null;

/** Forget the parsed token and the cached listing (tests change the env). */
export function resetRemoteCache(): void {
  parsed = null;
  listingPromise = null;
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

/** The refusal a `profile add` gets here, naming the hub the token points at. */
export function remoteCannotManageError(): CliError {
  return cannotManageProfilesError(hub().url);
}

/** A hub too old to know the right says nothing about it; that is the hub's problem, not the key's. */
export function hubTooOldToManageError(): CliError {
  return new CliError(
    'CONFIG_ERROR',
    `The vault hub at ${hub().url} does not support managing profiles from an agent`,
    'Update the hub to agentio 2.5 or later',
  );
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
    // Kept as TOKEN_EXPIRED, not widened to AUTH_FAILED: callers tell one
    // expired profile apart from a token the hub rejects outright, and only
    // the latter should abandon a run over every profile.
    case 'TOKEN_EXPIRED':
      return new CliError('TOKEN_EXPIRED', `Re-authentication is needed on the vault host: ${detail}`,
        'Reauth the profile on the hub host, then retry');
    case 'VAULT_LOCKED':
      return new CliError('CONFIG_ERROR', 'The vault is locked on the hub', `Unlock it at ${url}/ui`);
    default:
      return new CliError(code, detail, body.suggestion);
  }
}

export interface HubCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body; sets the content type. */
  body?: unknown;
  /** Bearer token; omitted for the public login routes. */
  token?: string;
}

/**
 * One JSON call to a hub. Transport failures are NETWORK_ERROR; an error
 * answer keeps the hub's own code and suggestion (see hubError). Shared by
 * the authenticated credential and profile calls and the pre-token login flow.
 */
export async function hubCall<T>(url: string, path: string, { method = 'GET', body, token }: HubCallOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError('NETWORK_ERROR', `Cannot reach the vault hub at ${url}: ${reason}`,
      'Check the network, and that the hub daemon is running');
  }
  const text = await response.text();
  let answer: unknown = null;
  try { answer = text ? JSON.parse(text) : null; } catch { answer = null; }
  if (!response.ok) throw hubError(response.status, (answer ?? {}) as { error?: string; code?: string; suggestion?: string }, url);
  return answer as T;
}

const hubRequest = <T>(path: string, method: HubCallOptions['method'] = 'GET', body?: unknown) =>
  hubCall<T>(hub().url, path, { method, body, token: remoteToken()! });

const profileRoute = (service: ServiceName, name: string) => `/v1/profiles/${encodeURIComponent(service)}/${encodeURIComponent(name)}`;

/** This key's view of the hub, fetched once per process and shared by both readers below. */
function remoteListing(): Promise<RemoteListing> {
  return (listingPromise ??= hubRequest<RemoteListing>('/v1/profiles'));
}

/** The profiles this token may use. */
export function remoteProfiles(): Promise<RemoteProfile[]> {
  return remoteListing().then((l) => l.profiles);
}

/** Whether this token may change which profiles the hub holds; undefined from a hub that predates the right. */
export function remoteCanManageProfiles(): Promise<boolean | undefined> {
  return remoteListing().then((l) => l.canManageProfiles);
}

/** The body of `PUT /v1/profiles/:service/:name`; the hub parses this same type. */
export type RemoteAddBody = SetProfileOptions & { credentials: object };

/** The body of `PATCH /v1/profiles/:service/:name`; the hub parses this same type. */
export type RemoteRenameBody = { name: string };

/** A `profile add` finished on this machine, handed to the hub to store. Replaces what the key already reaches. */
export async function remoteSaveProfile(service: ServiceName, name: string, credentials: object, options: SetProfileOptions): Promise<void> {
  const body: RemoteAddBody = { ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }), credentials };
  await hubRequest(profileRoute(service, name), 'PUT', body);
}

/** Rename a profile on the hub. */
export function remoteRenameProfile(service: ServiceName, from: string, to: string): Promise<WriteOutcome> {
  const body: RemoteRenameBody = { name: to };
  return absentAsOutcome(hubRequest(profileRoute(service, from), 'PATCH', body));
}

/** Drop a profile on the hub. */
export function remoteDeleteProfile(service: ServiceName, name: string): Promise<WriteOutcome> {
  return absentAsOutcome(hubRequest(profileRoute(service, name), 'DELETE'));
}

/**
 * A profile the hub does not hold is an outcome, not a failure: the caller
 * reports it the way the local path does. Everything else, a refusal or a
 * taken name included, keeps the hub's own error and wording.
 */
async function absentAsOutcome(call: Promise<unknown>): Promise<WriteOutcome> {
  try {
    await call;
    return 'ok';
  } catch (err) {
    if (err instanceof CliError && err.code === 'PROFILE_NOT_FOUND') return 'absent';
    throw err;
  }
}

/** Fresh credentials from the hub, in the shape the local code expects, or null when none are stored. */
export async function remoteCredentials<T = Record<string, unknown>>(service: ServiceName, name: string): Promise<T | null> {
  try {
    return (await hubRequest<{ credentials: T }>(`${profileRoute(service, name)}/credentials`, 'POST')).credentials;
  } catch (err) {
    // NOT_FOUND is "profile exists, nothing stored"; an unknown profile stays PROFILE_NOT_FOUND.
    if (err instanceof CliError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}
