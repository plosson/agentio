import { CliError, profileNotFoundError } from '../utils/errors';
import { isVaultUnlocked, lockVault, unlockVault } from '../vault/vault';
import { listProfileRefs, setProfileReadOnly } from '../config/config-manager';
import { deleteProfile } from '../utils/profile-commands';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey, type ApiKeyInput } from '../auth/api-keys';
import type { ServiceName } from '../types/config';
import { getProfileStatuses, type ProfileStatus } from '../commands/status';
import { RateLimiter } from './rate-limit';
import {
  clearSessions,
  createSession,
  expiredSessionCookie,
  hasSession,
  sessionCookie,
} from './session';
import { INDEX_HTML } from './ui/assets';
import { errorResponse, json, profilePath, readJson } from './http';

export interface UiContext {
  version: string;
}

/** Five wrong passphrases a minute per address, then 429 for the rest of it. */
export const unlockLimiter = new RateLimiter(5, 60_000);

function page(): Response {
  return new Response(INDEX_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleUnlock(request: Request, ip: string): Promise<Response> {
  if (!unlockLimiter.allow(ip)) {
    throw new CliError('RATE_LIMITED', 'Too many attempts, try again in a minute');
  }
  const { passphrase } = await readJson<{ passphrase?: unknown }>(request);
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CliError('INVALID_PARAMS', 'passphrase is required');
  }
  await unlockVault(passphrase);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(createSession()) });
}

function handleLock(): Response {
  lockVault();
  clearSessions();
  return new Response(null, { status: 204, headers: { 'Set-Cookie': expiredSessionCookie() } });
}

async function handleProfiles(): Promise<Response> {
  const profiles = (await listProfileRefs()).map((r) => ({ ...r, readOnly: r.readOnly ?? false }));
  return json({ profiles });
}

const noProfile = (ref: { service: ServiceName; name: string }) => profileNotFoundError(ref.service, ref.name);

async function handleDeleteProfile(ref: { service: ServiceName; name: string }): Promise<Response> {
  if (!(await deleteProfile(ref.service, ref.name))) throw noProfile(ref);
  return new Response(null, { status: 204 });
}

async function handlePatchProfile(request: Request, ref: { service: ServiceName; name: string }): Promise<Response> {
  const { readOnly } = await readJson<{ readOnly?: unknown }>(request);
  if (typeof readOnly !== 'boolean') throw new CliError('INVALID_PARAMS', 'readOnly must be a boolean');
  if (!(await setProfileReadOnly(ref.service, ref.name, readOnly))) throw noProfile(ref);
  return json({ service: ref.service, name: ref.name, readOnly });
}

/** `/ui/api/keys/<id>[/rotate]` → the id and whether the action is rotate, or null. */
function keyRef(pathname: string): { id: string; rotate: boolean } | null {
  const m = pathname.match(/^\/ui\/api\/keys\/([^/]+)(\/rotate)?$/);
  return m ? { id: decodeURIComponent(m[1]), rotate: !!m[2] } : null;
}

type KeyBody = ApiKeyInput & { url?: unknown };

async function handleCreateKey(request: Request): Promise<Response> {
  const body = await readJson<KeyBody>(request);
  return json(await createApiKey(body, body.url), 201);
}

async function handleUpdateKey(request: Request, id: string): Promise<Response> {
  return json(await updateApiKey(id, await readJson<KeyBody>(request)));
}

async function handleRotateKey(request: Request, id: string): Promise<Response> {
  const body = await readJson<KeyBody>(request);
  return json(await rotateApiKey(id, body.url));
}

async function handleRevokeKey(id: string): Promise<Response> {
  await revokeApiKey(id);
  return new Response(null, { status: 204 });
}

/** Same payload as `agentio status --json`. */
async function handleStatus(request: Request, ctx: UiContext): Promise<Response> {
  const test = new URL(request.url).searchParams.get('test') !== 'false';
  const statuses = await getProfileStatuses({ test });
  const services: Record<string, Array<Omit<ProfileStatus, 'service'>>> = {};
  for (const { service, ...rest } of statuses) {
    (services[service] ??= []).push(rest);
  }
  return json({ version: ctx.version, services });
}

/**
 * Routes under /ui. Returns null for anything else so the caller can keep
 * matching. The page and the session probe are public; the rest needs a
 * session, and the vault-reading routes additionally need it unlocked.
 */
export async function handleUiRequest(request: Request, ip: string, ctx: UiContext): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const { method } = request;

  if (!pathname.startsWith('/ui')) return null;

  try {
    if (method === 'GET' && (pathname === '/ui' || pathname === '/ui/')) return page();

    if (method === 'GET' && pathname === '/ui/api/session') {
      return json({ authenticated: hasSession(request), locked: !isVaultUnlocked() });
    }
    if (method === 'POST' && pathname === '/ui/api/unlock') return await handleUnlock(request, ip);

    if (!hasSession(request)) throw new CliError('AUTH_FAILED', 'Unauthorized');

    if (method === 'POST' && pathname === '/ui/api/lock') return handleLock();

    if (!isVaultUnlocked()) throw new CliError('VAULT_LOCKED', 'Vault is locked');

    if (method === 'GET' && pathname === '/ui/api/profiles') return await handleProfiles();
    if (method === 'GET' && pathname === '/ui/api/status') return await handleStatus(request, ctx);

    const ref = profilePath(pathname, '/ui/api/profiles');
    if (ref?.action) throw new CliError('NOT_FOUND', 'Not found');
    if (ref && method === 'DELETE') return await handleDeleteProfile(ref);
    if (ref && method === 'PATCH') return await handlePatchProfile(request, ref);

    if (method === 'GET' && pathname === '/ui/api/keys') return json({ keys: await listApiKeys() });
    if (method === 'POST' && pathname === '/ui/api/keys') return await handleCreateKey(request);
    const key = keyRef(pathname);
    if (key?.rotate && method === 'POST') return await handleRotateKey(request, key.id);
    if (key && !key.rotate && method === 'PATCH') return await handleUpdateKey(request, key.id);
    if (key && !key.rotate && method === 'DELETE') return await handleRevokeKey(key.id);

    throw new CliError('NOT_FOUND', 'Not found');
  } catch (err) {
    return errorResponse(err);
  }
}
