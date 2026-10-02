import { randomBytes } from 'crypto';
import { CliError, profileNotFoundError } from '../utils/errors';
import { isVaultUnlocked, lockVault, unlockVault } from '../vault/vault';
import { startKeepalive, stopKeepalive } from './keepalive';
import { sessionProfileRemoved, sessionProfileRenamed, sessionStatus, startSessions, stopSessions } from './sessions';
import { listProfileRefs, setProfileReadOnly } from '../config/config-manager';
import { deleteProfile, renameProfile, writeFailure } from '../config/profile-store';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey, updateApiKey, type ApiKeyInput, validateFlag } from '../auth/api-keys';
import type { ServiceName } from '../types/config';
import { getProfileStatus, getProfileStatuses, type ProfileStatus } from '../commands/status';
import { RateLimiter } from './rate-limit';
import {
  clearSessions,
  createSession,
  deleteSession,
  expiredSessionCookie,
  hasSession,
  isSecureRequest,
  sessionCookie,
} from './session';
import { INDEX_HTML } from './ui/assets';
import { approveDeviceAuth, denyDeviceAuth, describeDeviceAuth, listDeviceAuth } from './device-auth';
import { errorResponse, json, profilePath, readJson } from './http';
import { findServicePlugin, getPluginRegistry } from '../plugins/registry';
import { profileDetails } from '../plugins/profile-details';
import { getCredentials } from '../auth/token-store';
import { FONTS } from './ui/fonts';
import { isLegacyServicePlugin } from '../plugins/types';

export interface UiContext {
  version: string;
}

/** Five wrong passphrases a minute per address, then 429 for the rest of it. */
export const unlockLimiter = new RateLimiter(5, 60_000);

/**
 * Response headers that lock the admin UI down. The vault-unlock panel is a
 * prime clickjacking target, so framing is denied outright; a strict CSP with a
 * per-response nonce lets the single inline script and style run while blocking
 * anything injected, and HSTS keeps the browser on TLS. The page pulls in nothing
 * from another origin; only its own fonts come from 'self'.
 */
function securityHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Security-Policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; ` +
      `connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

function page(): Response {
  const nonce = randomBytes(16).toString('base64');
  const metadata = Object.fromEntries(getPluginRegistry().plugins.map((plugin) => [plugin.id, {
    displayName: plugin.displayName,
    color: plugin.brand?.color && /^#[0-9a-f]{6}$/i.test(plugin.brand.color) ? plugin.brand.color : undefined,
    // `agentio <id> profile add` exists for every plugin with profiles or a session.
    addable: Boolean(plugin.profile) || (isLegacyServicePlugin(plugin) && Boolean(plugin.session)),
    session: isLegacyServicePlugin(plugin) && Boolean(plugin.session),
    // `agentio profile reauth` only works where the plugin defines it; otherwise the fix is `profile add --profile <name>`.
    reauth: Boolean(plugin.profile?.reauthenticate),
  }]));
  const serialized = JSON.stringify(metadata).replace(/[<>&]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const html = INDEX_HTML
    .replaceAll('__CSP_NONCE__', nonce)
    .replace('__PLUGIN_METADATA__', serialized);
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(nonce) },
  });
}

async function handleUnlock(request: Request, ip: string): Promise<Response> {
  unlockLimiter.check(ip);
  const { passphrase } = await readJson<{ passphrase?: unknown }>(request);
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new CliError('INVALID_PARAMS', 'passphrase is required');
  }
  await unlockVault(passphrase);
  // Tokens are reachable again, so the keepalive starts here and passes at once.
  startKeepalive();
  await startSessions();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(createSession(), isSecureRequest(request)) });
}

const signedOut = (request: Request) =>
  new Response(null, { status: 204, headers: { 'Set-Cookie': expiredSessionCookie(isSecureRequest(request)) } });

async function handleLock(request: Request): Promise<Response> {
  lockVault();
  // Nothing to refresh once locked, and a pass would only log that every time.
  stopKeepalive();
  // Their stores are unreadable from now on, which is what locking means.
  await stopSessions();
  clearSessions();
  return signedOut(request);
}

/** Ends this browser's session only; the vault and other sessions are untouched. */
function handleLogout(request: Request): Response {
  deleteSession(request);
  return signedOut(request);
}

async function handleProfiles(): Promise<Response> {
  const profiles = (await listProfileRefs()).map((r) => ({ ...r, readOnly: r.readOnly ?? false }));
  return json({ profiles });
}

const noProfile = (ref: { service: ServiceName; name: string }) => profileNotFoundError(ref.service, ref.name);

async function handleDeleteProfile(ref: { service: ServiceName; name: string }): Promise<Response> {
  if (!(await deleteProfile(ref.service, ref.name))) throw noProfile(ref);
  await sessionProfileRemoved(ref.service, ref.name);
  return new Response(null, { status: 204 });
}

/** One PATCH for the two things a profile's row can change: its name, or its read-only flag. */
async function handlePatchProfile(request: Request, ref: { service: ServiceName; name: string }): Promise<Response> {
  const body = await readJson<{ readOnly?: unknown; name?: unknown }>(request);
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') throw new CliError('INVALID_PARAMS', 'name must be a string');
    const failure = writeFailure(await renameProfile(ref.service, ref.name, body.name), ref.service, ref.name, body.name);
    if (failure) throw failure;
    await sessionProfileRenamed(ref.service, ref.name, body.name);
    return json({ service: ref.service, name: body.name });
  }
  const readOnly = validateFlag('readOnly', body.readOnly);
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

/** `/ui/api/authorize/<user-code>` → the code, or null. */
function authorizeCode(pathname: string): string | null {
  const m = pathname.match(/^\/ui\/api\/authorize\/([^/]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Approve creates the key with the owner's chosen scope; deny just answers the CLI. */
async function handleAuthorize(request: Request, code: string): Promise<Response> {
  const body = await readJson<KeyBody & { approve?: unknown }>(request);
  if (body.approve !== true) {
    denyDeviceAuth(code);
    return new Response(null, { status: 204 });
  }
  return json({ key: await approveDeviceAuth(code, body, body.url) }, 201);
}

/** Sessions run in this very process, so their state is read here rather than over HTTP. */
const inDaemon = async (service: ServiceName, name: string) => sessionStatus(service, name);

/** Same payload as `agentio status --json`. */
async function handleStatus(request: Request, ctx: UiContext): Promise<Response> {
  const test = new URL(request.url).searchParams.get('test') !== 'false';
  const statuses = await getProfileStatuses({ test, sessionStatus: inDaemon });
  const services: Record<string, Array<Omit<ProfileStatus, 'service'> & { account?: string; url?: string }>> = {};
  for (const { service, ...rest } of statuses) {
    // Public facts only, read from the vault: no call to the service, no secret.
    const details = profileDetails(findServicePlugin(service), await getCredentials(service, rest.profile));
    (services[service] ??= []).push({ ...rest, ...details });
  }
  return json({ version: ctx.version, services });
}

/** `/ui/fonts/<file>`: the page's own fonts, public so the locked screen can use them. */
function font(pathname: string): Response | null {
  if (!pathname.startsWith('/ui/fonts/')) return null;
  const name = pathname.slice('/ui/fonts/'.length);
  // A plain-object lookup also matches inherited names like `constructor` or `toString`; require an own property.
  if (!Object.hasOwn(FONTS, name)) return errorResponse(new CliError('NOT_FOUND', 'Not found'));
  const bytes = FONTS[name];
  // TS's BodyInit wants a Uint8Array<ArrayBuffer>; our decoded bytes are typed ArrayBufferLike, same data.
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
  });
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
    if (method === 'GET') { const res = font(pathname); if (res) return res; }

    if (method === 'GET' && pathname === '/ui/api/session') {
      return json({ authenticated: hasSession(request), locked: !isVaultUnlocked() });
    }
    if (method === 'POST' && pathname === '/ui/api/unlock') return await handleUnlock(request, ip);

    if (!hasSession(request)) throw new CliError('AUTH_FAILED', 'Unauthorized');

    if (method === 'POST' && pathname === '/ui/api/lock') return await handleLock(request);
    if (method === 'POST' && pathname === '/ui/api/logout') return handleLogout(request);

    if (!isVaultUnlocked()) throw new CliError('VAULT_LOCKED', 'Vault is locked');

    if (method === 'GET' && pathname === '/ui/api/profiles') return await handleProfiles();
    if (method === 'GET' && pathname === '/ui/api/status') return await handleStatus(request, ctx);

    const ref = profilePath(pathname, '/ui/api/profiles');
    if (ref?.action === 'status' && method === 'GET') {
      const { service: _s, ...rest } = await getProfileStatus(ref.service, ref.name, { sessionStatus: inDaemon });
      return json(rest);
    }
    if (ref?.action) throw new CliError('NOT_FOUND', 'Not found');
    if (ref && method === 'DELETE') return await handleDeleteProfile(ref);
    if (ref && method === 'PATCH') return await handlePatchProfile(request, ref);

    if (method === 'GET' && pathname === '/ui/api/authorize') return json({ requests: listDeviceAuth() });

    const code = authorizeCode(pathname);
    if (code && method === 'GET') return json(describeDeviceAuth(code));
    if (code && method === 'POST') return await handleAuthorize(request, code);

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
