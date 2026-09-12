import { CliError, type ErrorCode } from '../utils/errors';
import { isVaultUnlocked, lockVault, unlockVault } from '../vault/vault';
import { listProfiles, setProfileReadOnly } from '../config/config-manager';
import { deleteProfile } from '../utils/profile-commands';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey } from '../auth/api-keys';
import { ALL_SERVICES, type ServiceName } from '../types/config';
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

export interface UiContext {
  version: string;
}

/** Five wrong passphrases a minute per address, then 429 for the rest of it. */
export const unlockLimiter = new RateLimiter(5, 60_000);

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  AUTH_FAILED: 401,
  INVALID_PARAMS: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  VAULT_LOCKED: 503,
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof CliError) {
    return json(
      { error: err.message, code: err.code, ...(err.suggestion ? { suggestion: err.suggestion } : {}) },
      HTTP_STATUS[err.code] ?? 500,
    );
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return json({ error: message, code: 'API_ERROR' }, 500);
}

function page(): Response {
  return new Response(INDEX_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleUnlock(request: Request, ip: string): Promise<Response> {
  if (!unlockLimiter.allow(ip)) {
    return json({ error: 'Too many attempts, try again in a minute', code: 'RATE_LIMITED' }, 429);
  }
  let passphrase: unknown;
  try {
    passphrase = ((await request.json()) as { passphrase?: unknown }).passphrase;
  } catch {
    return json({ error: 'Body must be JSON', code: 'INVALID_PARAMS' }, 400);
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    return json({ error: 'passphrase is required', code: 'INVALID_PARAMS' }, 400);
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
  const services = await listProfiles();
  const profiles = services.flatMap(({ service, profiles }) =>
    profiles.map((p) => ({ service, name: p.name, readOnly: p.readOnly ?? false })),
  );
  return json({ profiles });
}

/** `/ui/api/profiles/<service>/<name>` → the pair, or null when the path is not that shape. */
function profileRef(pathname: string): { service: ServiceName; name: string } | null {
  const m = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const service = decodeURIComponent(m[1]);
  if (!(ALL_SERVICES as readonly string[]).includes(service)) return null;
  return { service: service as ServiceName, name: decodeURIComponent(m[2]) };
}

async function handleDeleteProfile(ref: { service: ServiceName; name: string }): Promise<Response> {
  if (!(await deleteProfile(ref.service, ref.name))) {
    return json({ error: `No ${ref.service} profile "${ref.name}"`, code: 'NOT_FOUND' }, 404);
  }
  return new Response(null, { status: 204 });
}

async function handlePatchProfile(request: Request, ref: { service: ServiceName; name: string }): Promise<Response> {
  let readOnly: unknown;
  try {
    readOnly = ((await request.json()) as { readOnly?: unknown }).readOnly;
  } catch {
    return json({ error: 'Body must be JSON', code: 'INVALID_PARAMS' }, 400);
  }
  if (typeof readOnly !== 'boolean') {
    return json({ error: 'readOnly must be a boolean', code: 'INVALID_PARAMS' }, 400);
  }
  if (!(await setProfileReadOnly(ref.service, ref.name, readOnly))) {
    return json({ error: `No ${ref.service} profile "${ref.name}"`, code: 'NOT_FOUND' }, 404);
  }
  return json({ service: ref.service, name: ref.name, readOnly });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

const badBody = () => json({ error: 'Body must be JSON', code: 'INVALID_PARAMS' }, 400);
const noKey = (id: string) => json({ error: `No key with id ${id}`, code: 'NOT_FOUND' }, 404);

async function handleCreateKey(request: Request): Promise<Response> {
  const body = await readJson<{ name?: unknown; allowedProfiles?: unknown; readOnly?: unknown; url?: unknown }>(request);
  if (!body) return badBody();
  const issued = await createApiKey(
    { name: body.name as string, allowedProfiles: body.allowedProfiles as never, readOnly: body.readOnly as boolean },
    body.url as string,
  );
  return json(issued, 201);
}

async function handleUpdateKey(request: Request, id: string): Promise<Response> {
  const body = await readJson<{ name?: unknown; allowedProfiles?: unknown; readOnly?: unknown }>(request);
  if (!body) return badBody();
  const updated = await updateApiKey(id, {
    name: body.name as string | undefined,
    allowedProfiles: body.allowedProfiles as never,
    readOnly: body.readOnly as boolean | undefined,
  });
  return updated ? json(updated) : noKey(id);
}

async function handleRotateKey(request: Request, id: string): Promise<Response> {
  const body = await readJson<{ url?: unknown }>(request);
  if (!body) return badBody();
  const issued = await rotateApiKey(id, body.url as string);
  return issued ? json(issued) : noKey(id);
}

async function handleRevokeKey(id: string): Promise<Response> {
  return (await revokeApiKey(id)) ? new Response(null, { status: 204 }) : noKey(id);
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

    if (!hasSession(request)) return json({ error: 'Unauthorized', code: 'AUTH_FAILED' }, 401);

    if (method === 'POST' && pathname === '/ui/api/lock') return handleLock();

    if (!isVaultUnlocked()) return json({ error: 'Vault is locked', code: 'VAULT_LOCKED' }, 503);

    if (method === 'GET' && pathname === '/ui/api/profiles') return await handleProfiles();
    if (method === 'GET' && pathname === '/ui/api/status') return await handleStatus(request, ctx);

    const ref = profileRef(pathname);
    if (ref && method === 'DELETE') return await handleDeleteProfile(ref);
    if (ref && method === 'PATCH') return await handlePatchProfile(request, ref);

    if (method === 'GET' && pathname === '/ui/api/keys') return json({ keys: await listApiKeys() });
    if (method === 'POST' && pathname === '/ui/api/keys') return await handleCreateKey(request);
    const keyMatch = pathname.match(/^\/ui\/api\/keys\/([^/]+)(\/rotate)?$/);
    if (keyMatch) {
      const id = decodeURIComponent(keyMatch[1]);
      if (keyMatch[2] && method === 'POST') return await handleRotateKey(request, id);
      if (!keyMatch[2] && method === 'PATCH') return await handleUpdateKey(request, id);
      if (!keyMatch[2] && method === 'DELETE') return await handleRevokeKey(id);
    }

    return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
