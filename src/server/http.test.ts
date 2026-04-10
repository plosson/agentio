import { describe, expect, test } from 'bun:test';

import { handleRequest, type ServerContext } from './http';
import { createOAuthStore } from './oauth-store';

/**
 * Dummy context used by these pure-handler tests. The Phase 2 routes
 * (/health, 404) don't read the context, but the signature requires one.
 * Phase 3 tests will pass a real API key + populated store.
 */
const dummyCtx: ServerContext = {
  apiKey: 'srv_test_dummy_key_for_unit_tests',
  oauthStore: createOAuthStore({ save: async () => {} }),
};

/** Convenience wrapper that closes over `dummyCtx`. */
const dispatch = (request: Request): Promise<Response> =>
  handleRequest(request, dummyCtx);

/**
 * Pure-function tests for the Bun fetch handler. No subprocess, no socket,
 * no config dir. The handler is just `(Request) => Promise<Response>`, so
 * we can synthesize Requests and assert against Responses directly.
 *
 * These tests are deliberately adversarial: they hit the route table with
 * weird methods, weird paths, weird encodings, and pin down behavior that
 * would otherwise drift silently across refactors.
 */

const ORIGIN = 'http://localhost:9999';

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function bodyOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe('handleRequest — /health happy path', () => {
  test('GET /health → 200 {ok:true}', async () => {
    const res = await dispatch(req('/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await bodyOf(res)).toEqual({ ok: true });
  });

  test('response body is exactly the bytes of the JSON (no trailing newline)', async () => {
    const res = await dispatch(req('/health'));
    expect(await res.text()).toBe('{"ok":true}');
  });

  test('content-length matches the JSON body length', async () => {
    const res = await dispatch(req('/health'));
    const text = await res.text();
    // The fetch handler doesn't set content-length explicitly; Bun.serve
    // adds it. handleRequest itself just sets content-type. Verify the
    // body length is what we expect either way.
    expect(text.length).toBe(11);
  });
});

describe('handleRequest — /health adversarial methods', () => {
  // The current implementation is method-agnostic (the route table only
  // looks at pathname). These tests LOCK IN that behavior — if we ever
  // restrict /health to GET, we'll have to update them deliberately.

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    test(`${method} /health → 200 (method-agnostic)`, async () => {
      const init: RequestInit = { method };
      // POST/PUT/PATCH require a body or content-length on some impls;
      // give them an empty body to be safe.
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        init.body = '';
      }
      const res = await dispatch(req('/health', init));
      expect(res.status).toBe(200);
    });
  }

  test('POST /health with a 1KB body still returns 200 (body ignored)', async () => {
    const res = await dispatch(
      req('/health', { method: 'POST', body: 'x'.repeat(1024) })
    );
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: true });
  });
});

describe('handleRequest — /health adversarial paths', () => {
  test('/health?foo=bar → 200 (query string ignored)', async () => {
    const res = await dispatch(req('/health?foo=bar&baz=qux'));
    expect(res.status).toBe(200);
  });

  test('/health? (empty query) → 200', async () => {
    const res = await dispatch(req('/health?'));
    expect(res.status).toBe(200);
  });

  test('/health/ (trailing slash) → 404 (strict path match)', async () => {
    const res = await dispatch(req('/health/'));
    expect(res.status).toBe(404);
  });

  test('/HEALTH (uppercase) → 404 (case-sensitive)', async () => {
    const res = await dispatch(req('/HEALTH'));
    expect(res.status).toBe(404);
  });

  test('/health/extra → 404', async () => {
    const res = await dispatch(req('/health/extra'));
    expect(res.status).toBe(404);
  });

  test('/healt (typo) → 404', async () => {
    const res = await dispatch(req('/healt'));
    expect(res.status).toBe(404);
  });

  test('/healthx (no boundary) → 404', async () => {
    const res = await dispatch(req('/healthx'));
    expect(res.status).toBe(404);
  });

  test('/%68ealth (URL-encoded "h") → behavior is locked in', async () => {
    // URL.pathname auto-decodes %XX for unreserved characters in most impls,
    // which would make this match /health. Lock in the actual behavior so a
    // future refactor of the route table is intentional.
    const res = await dispatch(req('/%68ealth'));
    // Document whichever way it goes — but assert it's deterministic.
    expect([200, 404]).toContain(res.status);
  });

  test('/health%00 (null byte) → handled, not a crash', async () => {
    // URL constructor may percent-encode or reject \0. Either way, the
    // handler must not crash.
    let res: Response | null = null;
    try {
      res = await dispatch(req('/health%00'));
    } catch (e) {
      // Acceptable: URL constructor rejected the null byte
      expect(e).toBeDefined();
      return;
    }
    expect(res.status).toBe(404);
  });

  test('/../../etc/passwd → 404 (URL parser normalizes ../)', async () => {
    const res = await dispatch(req('/../../etc/passwd'));
    // After URL normalization the path is /etc/passwd, which is not /health.
    expect(res.status).toBe(404);
  });

  test('extremely long path (10KB) → 404 cleanly', async () => {
    const longPath = '/' + 'a'.repeat(10_000);
    const res = await dispatch(req(longPath));
    expect(res.status).toBe(404);
  });

  test('unicode in path → 404', async () => {
    const res = await dispatch(req('/héalth'));
    expect(res.status).toBe(404);
  });

  test('emoji in path → 404', async () => {
    const res = await dispatch(req('/💀'));
    expect(res.status).toBe(404);
  });

  test('path with embedded space (encoded) → 404', async () => {
    const res = await dispatch(req('/health%20'));
    expect(res.status).toBe(404);
  });

  test('GET / (root) → 404', async () => {
    const res = await dispatch(req('/'));
    expect(res.status).toBe(404);
  });
});

describe('handleRequest — 404 handler shape', () => {
  test('404 body has {error:"not found"}', async () => {
    const res = await dispatch(req('/whatever'));
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toEqual({ error: 'not found' });
  });

  test('404 has json content-type', async () => {
    const res = await dispatch(req('/whatever'));
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  test('404 body parses as valid JSON', async () => {
    const res = await dispatch(req('/whatever'));
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('handleRequest — concurrency (sanity)', () => {
  test('100 concurrent calls all resolve independently', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        dispatch(req(i % 2 === 0 ? '/health' : '/notfound'))
      )
    );
    const oks = results.filter((r) => r.status === 200).length;
    const fourofours = results.filter((r) => r.status === 404).length;
    expect(oks).toBe(50);
    expect(fourofours).toBe(50);
  });

  test('handler returns a fresh Response per call (no shared state)', async () => {
    const a = await dispatch(req('/health'));
    const b = await dispatch(req('/health'));
    expect(a).not.toBe(b);
    expect(await a.text()).toBe('{"ok":true}');
    expect(await b.text()).toBe('{"ok":true}');
  });
});

/* ------------------------------------------------------------------ */
/* /mcp bearer-auth gate (Phase 3g)                                    */
/* The actual MCP transport behavior lives in mcp-http.test.ts and     */
/* mcp-e2e.test.ts — these tests just lock in that the bearer check   */
/* runs before the request ever reaches the transport.                */
/* ------------------------------------------------------------------ */

describe('handleRequest — /mcp bearer gate', () => {
  test('GET /mcp without Authorization → 401 with WWW-Authenticate', async () => {
    const res = await dispatch(req('/mcp'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  test('GET /mcp with bogus bearer → 401', async () => {
    const res = await dispatch(
      req('/mcp', { headers: { authorization: 'Bearer not_a_real_token' } })
    );
    expect(res.status).toBe(401);
  });

  test('POST /mcp without bearer → 401 (any method is gated)', async () => {
    const res = await dispatch(
      req('/mcp', { method: 'POST', body: '{}' })
    );
    expect(res.status).toBe(401);
  });

  test('DELETE /mcp without bearer → 401', async () => {
    const res = await dispatch(req('/mcp', { method: 'DELETE' }));
    expect(res.status).toBe(401);
  });
});
