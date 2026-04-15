import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHmac } from 'crypto';

/**
 * Tests for the operator-facing setup page at `/`. Covers:
 *   - unauthenticated GET renders the login form
 *   - POST credential validation (bad key → 401; good key → 302 + Set-Cookie)
 *   - cookie attributes (HttpOnly, SameSite, Path, Max-Age; Secure only on https)
 *   - HMAC-cookie authentication: valid cookie → profiles page; stale cookie → login form
 *   - only services with ≥1 configured profile appear on the page
 *   - embedded JSON payload escapes `<` to avoid `</script>` injection
 *
 * The page calls `listProfiles()` from ../config/config-manager, which reads
 * the real ~/.config/agentio/config.json. Bun caches `os.homedir()` at
 * process start, so HOME overrides don't work here — instead we use
 * `mock.module` to replace `listProfiles` with a controllable stub.
 */

const API_KEY = 'srv_test_setup_page_api_key';
const COOKIE_NAME = 'agentio_setup';
const COOKIE_MAGIC = 'agentio-setup-v1';

function expectedCookieValue(apiKey: string): string {
  return createHmac('sha256', apiKey).update(COOKIE_MAGIC).digest('base64url');
}

interface FakeProfile {
  service: string;
  profiles: { name: string; readOnly?: boolean }[];
}

// Mutable container the mock consults on each call.
let currentProfiles: FakeProfile[] = [];

function setProfiles(fixture: Record<string, string[]>): void {
  currentProfiles = Object.entries(fixture).map(([service, names]) => ({
    service,
    profiles: names.map((n) => ({ name: n })),
  }));
}

type HandleRequest = (typeof import('./http'))['handleRequest'];
type CreateOAuthStore = (typeof import('./oauth-store'))['createOAuthStore'];
type ServerContext = import('./http').ServerContext;

let handleRequest: HandleRequest;
let createOAuthStore: CreateOAuthStore;
let ctx: ServerContext;

beforeAll(async () => {
  // Load the real config-manager first so we can preserve every export
  // other modules in the graph depend on (CONFIG_DIR, loadConfig, etc.),
  // then override ONLY listProfiles with a controllable stub. This has
  // to happen BEFORE the module-under-test is imported — once './http'
  // loads, the dependency is bound.
  const realConfig = await import('../config/config-manager');
  mock.module('../config/config-manager', () => ({
    ...realConfig,
    listProfiles: async (service?: string) => {
      if (service) {
        return currentProfiles.filter((s) => s.service === service);
      }
      return currentProfiles;
    },
  }));

  ({ handleRequest } = await import('./http'));
  ({ createOAuthStore } = await import('./oauth-store'));
  ctx = {
    apiKey: API_KEY,
    oauthStore: createOAuthStore({ save: async () => {} }),
  };
});

beforeEach(() => {
  currentProfiles = [];
});

afterEach(() => {
  currentProfiles = [];
});

function req(
  method: string,
  path: string,
  init: { cookie?: string; xfProto?: string; body?: string; contentType?: string } = {}
): Request {
  const headers = new Headers();
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.xfProto) headers.set('x-forwarded-proto', init.xfProto);
  if (init.contentType) headers.set('content-type', init.contentType);
  return new Request(`http://localhost:9999${path}`, {
    method,
    headers,
    body: init.body,
  });
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const FORM = 'application/x-www-form-urlencoded';

/* ------------------------------------------------------------------ */
/* unauthenticated GET                                                 */
/* ------------------------------------------------------------------ */

describe('GET / — unauthenticated', () => {
  test('renders HTML login form with 200', async () => {
    const res = await handleRequest(req('GET', '/'), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<title>agentio MCP setup</title>');
    expect(html).toContain('name="api_key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('action="/"');
  });

  test('does NOT set a cookie on the login form render', async () => {
    const res = await handleRequest(req('GET', '/'), ctx);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('does NOT leak profile data to an unauthenticated caller', async () => {
    setProfiles({ gmail: ['work-secret', 'personal-secret'] });
    const res = await handleRequest(req('GET', '/'), ctx);
    const html = await res.text();
    expect(html).not.toContain('work-secret');
    expect(html).not.toContain('personal-secret');
  });
});

/* ------------------------------------------------------------------ */
/* POST login                                                          */
/* ------------------------------------------------------------------ */

describe('POST / — login', () => {
  test('missing api_key → 401 with error message, no cookie', async () => {
    const res = await handleRequest(
      req('POST', '/', { contentType: FORM, body: formBody({}) }),
      ctx
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Invalid API key');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('wrong api_key → 401 with error message, no cookie', async () => {
    const res = await handleRequest(
      req('POST', '/', {
        contentType: FORM,
        body: formBody({ api_key: 'not-the-right-key' }),
      }),
      ctx
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Invalid API key');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('correct api_key with trailing whitespace (newline/space) → 302', async () => {
    // Regression: operators routinely paste the key with a trailing
    // newline from terminals. Byte-for-byte compare would silently
    // reject an otherwise-valid key; trim makes it forgiving.
    for (const suffix of [' ', '\n', '\r\n', '  \t']) {
      const res = await handleRequest(
        req('POST', '/', {
          contentType: FORM,
          body: formBody({ api_key: API_KEY + suffix }),
        }),
        ctx
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('set-cookie')).toContain(expectedCookieValue(API_KEY));
    }
  });

  test('correct api_key → 302 to /, sets cookie with expected attributes', async () => {
    const res = await handleRequest(
      req('POST', '/', {
        contentType: FORM,
        body: formBody({ api_key: API_KEY }),
      }),
      ctx
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toMatch(/Max-Age=\d+/);

    // Cookie value is deterministic HMAC(apiKey, magic).
    expect(setCookie).toContain(expectedCookieValue(API_KEY));
  });

  test('Secure flag added when x-forwarded-proto=https', async () => {
    const res = await handleRequest(
      req('POST', '/', {
        contentType: FORM,
        xfProto: 'https',
        body: formBody({ api_key: API_KEY }),
      }),
      ctx
    );
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  test('Secure flag NOT added on plain http', async () => {
    const res = await handleRequest(
      req('POST', '/', {
        contentType: FORM,
        body: formBody({ api_key: API_KEY }),
      }),
      ctx
    );
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });
});

/* ------------------------------------------------------------------ */
/* authenticated GET                                                   */
/* ------------------------------------------------------------------ */

describe('GET / — authenticated (valid cookie)', () => {
  const validCookie = () => `${COOKIE_NAME}=${expectedCookieValue(API_KEY)}`;

  test('valid cookie → renders the profiles page', async () => {
    setProfiles({ gmail: ['work'] });
    const res = await handleRequest(
      req('GET', '/', { cookie: validCookie() }),
      ctx
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MCP URL');
    expect(html).toContain('Claude Code command');
    expect(html).toContain('type="checkbox"');
  });

  test('only services with ≥1 profile appear (empty services hidden)', async () => {
    setProfiles({
      gmail: ['work', 'personal'],
      slack: ['team'],
      jira: [], // empty — should NOT render a section
    });
    const res = await handleRequest(
      req('GET', '/', { cookie: validCookie() }),
      ctx
    );
    const html = await res.text();
    expect(html).toContain('<h2>gmail</h2>');
    expect(html).toContain('value="gmail:work"');
    expect(html).toContain('value="gmail:personal"');
    expect(html).toContain('<h2>slack</h2>');
    expect(html).toContain('value="slack:team"');
    expect(html).not.toContain('<h2>jira</h2>');
  });

  test('no configured profiles → empty-state message, no checkboxes', async () => {
    setProfiles({});
    const res = await handleRequest(
      req('GET', '/', { cookie: validCookie() }),
      ctx
    );
    const html = await res.text();
    expect(html).toContain('No profiles configured');
    expect(html).not.toContain('type="checkbox"');
  });

  test('embedded JSON does not contain `</` that would close the script tag', async () => {
    setProfiles({ gmail: ['work'] });
    const res = await handleRequest(
      req('GET', '/', { cookie: validCookie() }),
      ctx
    );
    const html = await res.text();
    const marker = 'id="page-data"';
    const scriptIdx = html.indexOf(marker);
    expect(scriptIdx).toBeGreaterThan(-1);
    const open = html.indexOf('>', scriptIdx) + 1;
    const close = html.indexOf('</script>', open);
    const dataJson = html.slice(open, close);
    // No `</` inside the JSON — that's what the `\\u003c` escape guarantees.
    expect(dataJson).not.toContain('</');
    // The data block IS the JSON payload with origin set.
    expect(JSON.parse(dataJson)).toEqual({ origin: 'http://localhost:9999' });
  });

  test('stale cookie (HMAC of a different api key) → renders login form', async () => {
    setProfiles({ gmail: ['work'] });
    const staleCookie = `${COOKIE_NAME}=${expectedCookieValue('some-old-key')}`;
    const res = await handleRequest(
      req('GET', '/', { cookie: staleCookie }),
      ctx
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="api_key"');
    expect(html).not.toContain('MCP URL');
  });

  test('malformed cookie header does not crash', async () => {
    const res = await handleRequest(
      req('GET', '/', { cookie: 'garbage;;===;' }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="api_key"');
  });

  test('origin reflects x-forwarded-host/proto (behind a proxy)', async () => {
    setProfiles({ gmail: ['work'] });
    const headers = new Headers();
    headers.set('cookie', validCookie());
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', 'mcp.example.com');
    const res = await handleRequest(
      new Request('http://localhost:9999/', { method: 'GET', headers }),
      ctx
    );
    const html = await res.text();
    expect(html).toContain('{"origin":"https://mcp.example.com"}');
  });
});

/* ------------------------------------------------------------------ */
/* method dispatch                                                     */
/* ------------------------------------------------------------------ */

describe('method dispatch at /', () => {
  test('DELETE / falls through to 404 (not handled by setup page)', async () => {
    const res = await handleRequest(req('DELETE', '/'), ctx);
    expect(res.status).toBe(404);
  });
});
