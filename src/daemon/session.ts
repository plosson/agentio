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

export function clearSessions(): void {
  sessions.clear();
}

export function sessionCookie(id: string): string {
  return `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

export function expiredSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
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
