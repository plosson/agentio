import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SESSION_IDLE_MS,
  clearSessions,
  createSession,
  expiredSessionCookie,
  hasSession,
  sessionCookie,
} from './session';

function withCookie(cookie: string | null): Request {
  return new Request('http://x/ui/api/status', { headers: cookie ? { cookie } : {} });
}

beforeEach(() => clearSessions());

describe('sessions', () => {
  test('a fresh session is accepted via its cookie', () => {
    const id = createSession();
    const cookie = sessionCookie(id);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(hasSession(withCookie(`agentio_session=${id}`))).toBe(true);
  });

  test('no cookie, unknown id, or other cookies only are rejected', () => {
    createSession();
    expect(hasSession(withCookie(null))).toBe(false);
    expect(hasSession(withCookie('agentio_session=nope'))).toBe(false);
    expect(hasSession(withCookie('theme=dark; other=1'))).toBe(false);
  });

  test('idle sessions expire, active ones are extended', () => {
    const t0 = 1_000_000;
    const id = createSession(t0);
    const req = withCookie(`agentio_session=${id}`);
    expect(hasSession(req, t0 + SESSION_IDLE_MS - 1)).toBe(true);
    // The touch above moved lastSeen, so another near-full idle window is fine.
    expect(hasSession(req, t0 + 2 * SESSION_IDLE_MS - 2)).toBe(true);
    expect(hasSession(req, t0 + 3 * SESSION_IDLE_MS + 1)).toBe(false);
    // Once expired it stays expired even if asked again earlier in time.
    expect(hasSession(req, t0)).toBe(false);
  });

  test('clearSessions drops every session', () => {
    const id = createSession();
    clearSessions();
    expect(hasSession(withCookie(`agentio_session=${id}`))).toBe(false);
  });

  test('expired cookie clears the browser copy', () => {
    expect(expiredSessionCookie()).toContain('Max-Age=0');
  });
});
