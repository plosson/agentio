import { CliError, profileNotFoundError } from '../utils/errors';
import { isVaultUnlocked } from '../vault/vault';
import { listProfileRefs, resolveProfile } from '../config/config-manager';
import { getAllCredentials, getCredentials } from '../auth/token-store';
import { HUB_REFRESH_BUFFER_MS, getFreshCredentials, redactForRemote } from '../auth/refresh';
import { authenticateToken, effectiveReadOnly, keyAllows, touchApiKey, type ApiKeyView } from '../auth/api-keys';
import type { ServiceName } from '../types/config';
import { RateLimiter } from './rate-limit';
import { errorResponse, json, profilePath } from './http';

/**
 * The credential API remote agents call with `Authorization: Bearer agio1.…`.
 * The hub is a transparent vault: a profile's credentials come back in the
 * shape the local code expects, refreshed first when stale, minus the fields
 * that would let the agent refresh on its own.
 */

/** Five bad tokens a minute per address; a valid token is never limited by address. */
export const v1AuthLimiter = new RateLimiter(5, 60_000);

/**
 * Requests a minute per key. An agent touches a handful of profiles per
 * command, so this is far above any honest use and only stops a leaked token
 * from hammering the hub. Upstream token endpoints are protected separately,
 * by the refresh buffer and the per-profile mutex.
 */
export const V1_REQUESTS_PER_MINUTE = 120;
export const v1KeyLimiter = new RateLimiter(
  V1_REQUESTS_PER_MINUTE,
  60_000,
  `More than ${V1_REQUESTS_PER_MINUTE} requests a minute for this key, try again in a minute`,
);

async function authenticate(request: Request, ip: string): Promise<ApiKeyView> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const key = token ? await authenticateToken(token) : null;
  if (!key) {
    v1AuthLimiter.check(ip);
    throw new CliError('AUTH_FAILED', 'Invalid or missing token', 'Set AGENTIO_TOKEN to a token from the hub');
  }
  return key;
}

/** The profile must exist and be on the key's allow-list; returns its effective read-only flag. */
async function allowedProfile(key: ApiKeyView, service: ServiceName, name: string): Promise<boolean> {
  const resolved = await resolveProfile(service, name);
  if (resolved.profile === null) throw profileNotFoundError(service, name);
  if (!keyAllows(key, service, name)) {
    throw new CliError('PERMISSION_DENIED', `This token is not allowed to use ${service}/${name}`);
  }
  return effectiveReadOnly(key, resolved.readOnly);
}

function audit(key: ApiKeyView, service: string, name: string, outcome: string, refreshed?: boolean): void {
  const extra = refreshed === undefined ? '' : ` refreshed=${refreshed}`;
  console.log(`${new Date().toISOString()} v1 credentials key=${key.id} (${key.name}) profile=${service}/${name} outcome=${outcome}${extra}`);
}

/** Credentials the way the hub hands them out: refreshed with the wider buffer. */
const hubCredentials = (service: ServiceName, name: string) =>
  getFreshCredentials<Record<string, unknown>>(service, name, { bufferMs: HUB_REFRESH_BUFFER_MS });

async function handleList(key: ApiKeyView): Promise<Response> {
  const stored = await getAllCredentials();
  const profiles = (await listProfileRefs())
    .filter((r) => keyAllows(key, r.service, r.name))
    .map((r) => ({
      service: r.service,
      name: r.name,
      readOnly: effectiveReadOnly(key, r.readOnly),
      hasCredentials: !!stored[r.service]?.[r.name],
    }));
  return json({ profiles });
}

/** Distinct from a bad token on the wire: 404 NOT_FOUND, not 401. */
async function requireStoredCredentials(service: ServiceName, name: string): Promise<void> {
  if (!(await getCredentials(service, name))) {
    throw new CliError('NOT_FOUND', `No credentials stored for ${service}/${name}`, 'Add them on the hub host');
  }
}

async function handleStatus(key: ApiKeyView, service: ServiceName, name: string): Promise<Response> {
  const readOnly = await allowedProfile(key, service, name);
  if (!(await getCredentials(service, name))) return json({ status: 'no_creds', readOnly });
  try {
    await hubCredentials(service, name);
    return json({ status: 'ok', readOnly });
  } catch (err) {
    if (err instanceof CliError && err.code === 'TOKEN_EXPIRED') return json({ status: 'needs_reauth', readOnly });
    throw err;
  }
}

async function handleCredentials(key: ApiKeyView, service: ServiceName, name: string): Promise<Response> {
  const readOnly = await allowedProfile(key, service, name);
  await requireStoredCredentials(service, name);
  try {
    const { credentials, refreshed } = await hubCredentials(service, name);
    audit(key, service, name, 'ok', refreshed);
    return json({ service, name, readOnly, refreshed, credentials: redactForRemote(service, credentials) });
  } catch (err) {
    if (err instanceof CliError) audit(key, service, name, err.code.toLowerCase());
    throw err;
  }
}

/** Routes under /v1. Returns null for anything else. */
export async function handleV1Request(request: Request, ip: string): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  if (!pathname.startsWith('/v1/')) return null;

  try {
    if (!isVaultUnlocked()) throw new CliError('VAULT_LOCKED', 'Vault is locked on the hub');
    const key = await authenticate(request, ip);
    v1KeyLimiter.check(key.id);
    // Awaited: a write must never be left pending after the request is answered.
    await touchApiKey(key);

    if (method === 'GET' && pathname === '/v1/profiles') return await handleList(key);

    const ref = profilePath(pathname, '/v1/profiles');
    if (ref && ref.action === null && method === 'GET') return await handleStatus(key, ref.service, ref.name);
    if (ref && ref.action === 'credentials' && method === 'POST') return await handleCredentials(key, ref.service, ref.name);

    throw new CliError('NOT_FOUND', 'Not found');
  } catch (err) {
    return errorResponse(err);
  }
}
