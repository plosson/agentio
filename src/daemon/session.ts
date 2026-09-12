import { randomBytes } from 'crypto';

/** A browser session expires after this much idle time. The vault does not. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
const COOKIE_NAME = 'agentio_session';

const sessions = new Map<string, number>(); // id -> lastSeen

export function createSession(now = Date.now()): string {
  const id = randomBytes(32).toString('base64url');
  sessions.set(id, now);
  return id;
}

/** True when the request carries a live session; touching it extends the idle window. */
export function hasSession(request: Request, now = Date.now()): boolean {
  const id = sessionIdFrom(request);
  if (!id) return false;
  const lastSeen = sessions.get(id);
  if (lastSeen === undefined) return false;
  if (now - lastSeen > SESSION_IDLE_MS) {
    sessions.delete(id);
    return false;
  }
  sessions.set(id, now);
  return true;
}

/** Forget the session this request carries, if any. Other browsers stay signed in. */
export function deleteSession(request: Request): void {
  const id = sessionIdFrom(request);
  if (id) sessions.delete(id);
}

export function clearSessions(): void {
  sessions.clear();
}

/**
 * `Secure` only when the request itself came over HTTPS: browsers accept a
 * Secure cookie over plain HTTP for localhost and 127.0.0.1 but drop it for any
 * other host, which would make an unlock over http://0.0.0.0 or a LAN address
 * silently fail. Behind the TLS proxy the forwarded protocol says https.
 */
export function isSecureRequest(request: Request): boolean {
  return request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:';
}

const cookieAttributes = (secure: boolean) => `HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Path=/`;

export function sessionCookie(id: string, secure: boolean): string {
  return `${COOKIE_NAME}=${id}; ${cookieAttributes(secure)}`;
}

export function expiredSessionCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; ${cookieAttributes(secure)}; Max-Age=0`;
}

function sessionIdFrom(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return rest.join('=') || null;
  }
  return null;
}
