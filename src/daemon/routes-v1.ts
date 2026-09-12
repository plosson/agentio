import { CliError, profileNotFoundError } from '../utils/errors';
import { isVaultUnlocked } from '../vault/vault';
import { listProfileRefs, resolveProfile } from '../config/config-manager';
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

/** Five bad tokens a minute per address; a valid token is never limited. */
export const v1AuthLimiter = new RateLimiter(5, 60_000);

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
  const profiles = (await listProfileRefs())
    .filter((r) => keyAllows(key, r.service, r.name))
    .map((r) => ({ service: r.service, name: r.name, readOnly: effectiveReadOnly(key, r.readOnly) }));
  return json({ profiles });
}

async function handleStatus(key: ApiKeyView, service: ServiceName, name: string): Promise<Response> {
  const readOnly = await allowedProfile(key, service, name);
  try {
    await hubCredentials(service, name);
    return json({ status: 'ok', readOnly });
  } catch (err) {
    if (err instanceof CliError && err.code === 'AUTH_FAILED') return json({ status: 'no_creds', readOnly });
    if (err instanceof CliError && err.code === 'TOKEN_EXPIRED') return json({ status: 'needs_reauth', readOnly });
    throw err;
  }
}

async function handleCredentials(key: ApiKeyView, service: ServiceName, name: string): Promise<Response> {
  const readOnly = await allowedProfile(key, service, name);
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
