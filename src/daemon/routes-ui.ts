import { CliError, type ErrorCode } from '../utils/errors';
import { isVaultUnlocked, lockVault, unlockVault } from '../vault/vault';
import { listProfiles } from '../config/config-manager';
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

    return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
