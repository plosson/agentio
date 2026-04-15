import { describe, expect, test } from 'bun:test';

import { createHash } from 'crypto';

import type { ServerContext } from './http';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  computeS256Challenge,
  constantTimeEquals,
  getRequestOrigin,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleToken,
  requireBearer,
} from './oauth';
import { createOAuthStore } from './oauth-store';

const TEST_API_KEY = 'srv_test_key_for_unit_tests';

function makeCtx(): ServerContext {
  return {
    apiKey: TEST_API_KEY,
    oauthStore: createOAuthStore({ save: async () => {} }),
  };
}

/**
 * Register a client and return its full client_id. Used as setup for
 * /authorize and /token tests.
 */
async function registerTestClient(
  ctx: ServerContext,
  redirectUri = 'http://localhost:53682/callback',
  clientName = 'Claude Code'
): Promise<string> {
  const c = await ctx.oauthStore.registerClient({
    clientName,
    redirectUris: [redirectUri],
  });
  return c.clientId;
}

/** Build a GET /authorize request with the given params. */
function authorizeGet(
  params: Record<string, string>,
  origin = 'http://localhost:9999'
): Request {
  const search = new URLSearchParams(params);
  return new Request(`${origin}/authorize?${search}`);
}

/** Build a POST /authorize form submission with the given params. */
function authorizePost(
  params: Record<string, string>,
  origin = 'http://localhost:9999'
): Request {
  const body = new URLSearchParams(params).toString();
  return new Request(`${origin}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/** Build a POST /token form submission. */
function tokenPost(
  params: Record<string, string>,
  origin = 'http://localhost:9999'
): Request {
  return new Request(`${origin}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

/**
 * Generate a valid PKCE pair: a 64-char unreserved verifier and its S256
 * challenge. The verifier characters are drawn from the RFC 7636 set
 * `[A-Za-z0-9-._~]`.
 */
function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = 'a'.repeat(64); // 64 chars, all valid
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

/**
 * End-to-end helper: register a client, walk POST /authorize, return the
 * issued code + the PKCE verifier needed at /token.
 */
async function getAuthCode(
  ctx: ServerContext,
  apiKey: string = TEST_API_KEY
): Promise<{
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}> {
  const clientId = await registerTestClient(ctx);
  const redirectUri = 'http://localhost:53682/callback';
  const { verifier, challenge } = makePkcePair();
  const res = await handleAuthorizePost(
    authorizePost({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: '',
      scope: 'mcp',
      api_key: apiKey,
    }),
    ctx
  );
  if (res.status !== 302) {
    throw new Error(`expected 302, got ${res.status}: ${await res.text()}`);
  }
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  return { clientId, redirectUri, code, verifier };
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost:9999${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* getRequestOrigin                                                    */
/* ------------------------------------------------------------------ */

describe('getRequestOrigin', () => {
  test('falls back to the Request URL when no proxy headers are set', () => {
    const req = new Request('http://localhost:9999/whatever');
    expect(getRequestOrigin(req)).toBe('http://localhost:9999');
  });

  test('strips path and query from the Request URL', () => {
    const req = new Request('https://example.com:8443/foo/bar?baz=qux');
    expect(getRequestOrigin(req)).toBe('https://example.com:8443');
  });

  test('honors X-Forwarded-Proto + X-Forwarded-Host', () => {
    const req = new Request('http://10.0.0.5:9999/x', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'agentio.example.com',
      },
    });
    expect(getRequestOrigin(req)).toBe('https://agentio.example.com');
  });

  test('Forwarded: header (RFC 7239) overrides X-Forwarded-*', () => {
    const req = new Request('http://10.0.0.5:9999/x', {
      headers: {
        forwarded: 'proto=https;host=agentio.example.com',
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'wrong.example.com',
      },
    });
    expect(getRequestOrigin(req)).toBe('https://agentio.example.com');
  });

  test('Forwarded: header with quoted host value', () => {
    const req = new Request('http://10.0.0.5:9999/x', {
      headers: {
        forwarded: 'proto=https;host="agentio.example.com:8443"',
      },
    });
    expect(getRequestOrigin(req)).toBe('https://agentio.example.com:8443');
  });

  test('Forwarded: with only proto (no host) falls back to next strategy', () => {
    const req = new Request('http://10.0.0.5:9999/x', {
      headers: {
        forwarded: 'proto=https',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'fallback.example.com',
      },
    });
    expect(getRequestOrigin(req)).toBe('https://fallback.example.com');
  });

  test('only one of X-Forwarded-Proto / X-Forwarded-Host falls back to URL', () => {
    const req = new Request('http://10.0.0.5:9999/x', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(getRequestOrigin(req)).toBe('http://10.0.0.5:9999');
  });

  test('preserves IPv6 host literals from the URL', () => {
    const req = new Request('http://[::1]:9999/x');
    expect(getRequestOrigin(req)).toBe('http://[::1]:9999');
  });
});

/* ------------------------------------------------------------------ */
/* metadata documents                                                  */
/* ------------------------------------------------------------------ */

describe('buildProtectedResourceMetadata', () => {
  test('contains required RFC 9728 fields', () => {
    const req = new Request('http://localhost:9999/.well-known/oauth-protected-resource');
    const m = buildProtectedResourceMetadata(req) as Record<string, unknown>;
    expect(m.resource).toBe('http://localhost:9999/mcp');
    expect(m.authorization_servers).toEqual(['http://localhost:9999']);
    expect(m.bearer_methods_supported).toEqual(['header']);
    expect(m.scopes_supported).toEqual(['mcp']);
  });

  test('uses the proxied origin when X-Forwarded-* is present', () => {
    const req = new Request('http://10.0.0.5:9999/.well-known/oauth-protected-resource', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'agentio.example.com',
      },
    });
    const m = buildProtectedResourceMetadata(req) as Record<string, unknown>;
    expect(m.resource).toBe('https://agentio.example.com/mcp');
    expect(m.authorization_servers).toEqual(['https://agentio.example.com']);
  });
});

describe('buildAuthorizationServerMetadata', () => {
  test('contains the four RFC 8414 endpoint URLs', () => {
    const req = new Request('http://localhost:9999/.well-known/oauth-authorization-server');
    const m = buildAuthorizationServerMetadata(req) as Record<string, unknown>;
    expect(m.issuer).toBe('http://localhost:9999');
    expect(m.authorization_endpoint).toBe('http://localhost:9999/authorize');
    expect(m.token_endpoint).toBe('http://localhost:9999/token');
    expect(m.registration_endpoint).toBe('http://localhost:9999/register');
  });

  test('advertises authorization_code grant + S256 PKCE only', () => {
    const req = new Request('http://localhost:9999/.well-known/oauth-authorization-server');
    const m = buildAuthorizationServerMetadata(req) as Record<string, unknown>;
    expect(m.response_types_supported).toEqual(['code']);
    expect(m.grant_types_supported).toEqual(['authorization_code']);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
  });

  test('advertises public client / no client_secret', () => {
    const req = new Request('http://localhost:9999/.well-known/oauth-authorization-server');
    const m = buildAuthorizationServerMetadata(req) as Record<string, unknown>;
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  test('endpoint URLs follow the proxied origin', () => {
    const req = new Request('http://10.0.0.5:9999/.well-known/oauth-authorization-server', {
      headers: {
        forwarded: 'proto=https;host=agentio.example.com',
      },
    });
    const m = buildAuthorizationServerMetadata(req) as Record<string, unknown>;
    expect(m.issuer).toBe('https://agentio.example.com');
    expect(m.authorization_endpoint).toBe('https://agentio.example.com/authorize');
    expect(m.token_endpoint).toBe('https://agentio.example.com/token');
    expect(m.registration_endpoint).toBe('https://agentio.example.com/register');
  });
});

/* ------------------------------------------------------------------ */
/* handleRegister (DCR)                                                */
/* ------------------------------------------------------------------ */

describe('handleRegister — happy path', () => {
  test('registers a client and returns 201 + RFC 7591 fields', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:53682/callback'],
      }),
      ctx
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^cli_/);
    expect(body.client_name).toBe('Claude Code');
    expect(body.redirect_uris).toEqual(['http://localhost:53682/callback']);
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(typeof body.client_id_issued_at).toBe('number');
    // The client should now be findable in the store.
    expect(ctx.oauthStore.findClient(body.client_id as string)).toBeDefined();
  });

  test('registers without client_name (it is optional)', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        redirect_uris: ['http://localhost/cb'],
      }),
      ctx
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toMatch(/^cli_/);
    expect(body.client_name).toBeUndefined();
  });

  test('multiple redirect_uris are all stored', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        redirect_uris: [
          'http://localhost:53682/cb1',
          'https://example.com/cb2',
        ],
      }),
      ctx
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.redirect_uris).toEqual([
      'http://localhost:53682/cb1',
      'https://example.com/cb2',
    ]);
  });

  test('issued at is a unix epoch SECONDS value, not ms', async () => {
    const before = Math.floor(Date.now() / 1000);
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: ['http://x/cb'] }),
      ctx
    );
    const body = (await res.json()) as Record<string, unknown>;
    const after = Math.floor(Date.now() / 1000);
    const issued = body.client_id_issued_at as number;
    expect(issued).toBeGreaterThanOrEqual(before);
    expect(issued).toBeLessThanOrEqual(after);
  });
});

describe('handleRegister — adversarial inputs', () => {
  test('non-JSON body → 400 invalid_client_metadata', async () => {
    const ctx = makeCtx();
    const req = new Request('http://localhost:9999/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json {',
    });
    const res = await handleRegister(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client_metadata');
  });

  test('empty body → 400', async () => {
    const ctx = makeCtx();
    const req = new Request('http://localhost:9999/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    const res = await handleRegister(req, ctx);
    expect(res.status).toBe(400);
  });

  test('JSON body that is an array → 400 (must be an object)', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(postJson('/register', []), ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client_metadata');
  });

  test('JSON body that is null → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(postJson('/register', null), ctx);
    expect(res.status).toBe(400);
  });

  test('missing redirect_uris → 400 invalid_redirect_uri', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { client_name: 'x' }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  test('redirect_uris is empty array → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: [] }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  test('redirect_uris is not an array → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: 'http://x/cb' }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('redirect_uri entry is not a string → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: [123, 'http://x/cb'] }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('redirect_uri entry is empty string → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: [''] }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('redirect_uri entry is malformed → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: ['not a url'] }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('redirect_uri scheme javascript: → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        redirect_uris: ['javascript:alert(1)'],
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_redirect_uri');
  });

  test('redirect_uri scheme data: → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        redirect_uris: ['data:text/html,<script>alert(1)</script>'],
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('redirect_uri scheme file: → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', { redirect_uris: ['file:///etc/passwd'] }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('client_name is not a string → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        client_name: 12345,
        redirect_uris: ['http://x/cb'],
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('client_name >200 chars → 400', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        client_name: 'x'.repeat(201),
        redirect_uris: ['http://x/cb'],
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('client_name exactly 200 chars → 201 (boundary)', async () => {
    const ctx = makeCtx();
    const res = await handleRegister(
      postJson('/register', {
        client_name: 'x'.repeat(200),
        redirect_uris: ['http://x/cb'],
      }),
      ctx
    );
    expect(res.status).toBe(201);
  });
});

describe('handleRegister — store integration', () => {
  test('two registrations produce distinct client_ids', async () => {
    const ctx = makeCtx();
    const res1 = await handleRegister(
      postJson('/register', { redirect_uris: ['http://a/cb'] }),
      ctx
    );
    const res2 = await handleRegister(
      postJson('/register', { redirect_uris: ['http://b/cb'] }),
      ctx
    );
    const body1 = (await res1.json()) as Record<string, unknown>;
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body1.client_id).not.toBe(body2.client_id);
    expect(ctx.oauthStore.listClients()).toHaveLength(2);
  });

  test('failed validation does NOT add a client to the store', async () => {
    const ctx = makeCtx();
    await handleRegister(
      postJson('/register', { redirect_uris: ['javascript:alert(1)'] }),
      ctx
    );
    expect(ctx.oauthStore.listClients()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* constantTimeEquals                                                  */
/* ------------------------------------------------------------------ */

describe('constantTimeEquals', () => {
  test('identical strings → true', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });

  test('different strings of equal length → false', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  test('different lengths → false (no crash)', () => {
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });

  test('empty strings → true', () => {
    expect(constantTimeEquals('', '')).toBe(true);
  });

  test('unicode strings work', () => {
    expect(constantTimeEquals('héllo', 'héllo')).toBe(true);
    expect(constantTimeEquals('héllo', 'hello')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* handleAuthorizeGet                                                  */
/* ------------------------------------------------------------------ */

describe('handleAuthorizeGet — happy path', () => {
  test('renders an HTML form with the API key field', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHALLENGE',
        code_challenge_method: 'S256',
        state: 'STATE_VALUE',
        scope: 'gchat:default',
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/authorize">');
    expect(html).toContain('name="api_key"');
    expect(html).toContain('Claude Code');
    expect(html).toContain('gchat:default');
  });

  test('preserves all OAuth params as hidden inputs', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHALLENGE_PRESERVED',
        code_challenge_method: 'S256',
        state: 'STATE_PRESERVED',
        scope: 'mcp',
      }),
      ctx
    );
    const html = await res.text();
    expect(html).toContain(`value="${clientId}"`);
    expect(html).toContain('value="CHALLENGE_PRESERVED"');
    expect(html).toContain('value="STATE_PRESERVED"');
    expect(html).toContain('value="S256"');
  });

  test('escapes hostile state values to prevent reflected XSS', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
        state: '"><script>alert(1)</script>',
        scope: '',
      }),
      ctx
    );
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes hostile scope values', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
        state: '',
        scope: '<img src=x onerror=alert(1)>',
      }),
      ctx
    );
    const html = await res.text();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('escapes hostile client_name (set at DCR time)', async () => {
    const ctx = makeCtx();
    const c = await ctx.oauthStore.registerClient({
      clientName: '<script>alert("XSS")</script>',
      redirectUris: ['http://localhost/cb'],
    });
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: c.clientId,
        redirect_uri: 'http://localhost/cb',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
      }),
      ctx
    );
    const html = await res.text();
    expect(html).not.toContain('<script>alert("XSS")</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('handleAuthorizeGet — validation errors', () => {
  test('missing client_id → 400 invalid_request', async () => {
    const ctx = makeCtx();
    const res = await handleAuthorizeGet(
      authorizeGet({
        redirect_uri: 'http://localhost/cb',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  test('unknown client_id → 400 invalid_client', async () => {
    const ctx = makeCtx();
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: 'cli_does_not_exist',
        redirect_uri: 'http://localhost/cb',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_client');
  });

  test('redirect_uri not in registered list → 400 invalid_request', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://attacker.example.com/cb',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  test('response_type ≠ code → 400', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'token', // implicit flow not supported
        code_challenge: 'X',
        code_challenge_method: 'S256',
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('missing code_challenge → 400 (PKCE required)', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge_method: 'S256',
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('code_challenge_method ≠ S256 → 400', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizeGet(
      authorizeGet({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'plain', // explicitly disallowed
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* handleAuthorizePost                                                 */
/* ------------------------------------------------------------------ */

describe('handleAuthorizePost — happy path', () => {
  test('valid API key → 302 to redirect_uri with code + state', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: 'STATE_XYZ',
        scope: 'gchat:default',
        api_key: TEST_API_KEY,
      }),
      ctx
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBeDefined();
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe(
      'http://localhost:53682/callback'
    );
    expect(url.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get('state')).toBe('STATE_XYZ');
  });

  test('api_key with trailing whitespace still authorizes (trim)', async () => {
    // Regression: operators often paste the key with a trailing newline
    // from terminals. Byte-for-byte compare would silently reject.
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    for (const suffix of [' ', '\n', '\r\n', '  \t']) {
      const res = await handleAuthorizePost(
        authorizePost({
          client_id: clientId,
          redirect_uri: 'http://localhost:53682/callback',
          response_type: 'code',
          code_challenge: 'CHAL',
          code_challenge_method: 'S256',
          state: '',
          scope: 'gchat:default',
          api_key: TEST_API_KEY + suffix,
        }),
        ctx
      );
      expect(res.status).toBe(302);
    }
  });

  test('issued code is consumable from the store', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: '',
        scope: 'gchat:default',
        api_key: TEST_API_KEY,
      }),
      ctx
    );
    const code = new URL(res.headers.get('location')!).searchParams.get(
      'code'
    )!;

    const consumed = ctx.oauthStore.consumeCode(code);
    expect(consumed).toBeDefined();
    expect(consumed!.clientId).toBe(clientId);
    expect(consumed!.codeChallenge).toBe('CHAL');
    expect(consumed!.scope).toBe('gchat:default');
    expect(consumed!.redirectUri).toBe('http://localhost:53682/callback');
  });

  test('missing state in form → no state in redirect URL', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: '',
        scope: 'mcp',
        api_key: TEST_API_KEY,
      }),
      ctx
    );
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.has('state')).toBe(false);
  });
});

describe('handleAuthorizePost — adversarial', () => {
  test('wrong API key → re-renders form with error (NOT a redirect)', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: 'srv_wrong_key_value',
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('Invalid API key');
    // The form must be re-rendered with the original hidden inputs, so the
    // user can re-submit with the right key.
    expect(html).toContain('<form method="post" action="/authorize">');
    expect(html).toContain('value="CHAL"');
  });

  test('empty API key → form re-rendered with error', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: '',
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Invalid API key');
  });

  test('API key off by one character → form re-rendered with error', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const wrong = TEST_API_KEY.slice(0, -1) + 'X';
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: wrong,
      }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Invalid API key');
  });

  test('failed POST does NOT issue a code', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        response_type: 'code',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: 'wrong',
      }),
      ctx
    );
    // No code was issued, so consuming any string returns undefined.
    // (We can't easily enumerate codes from the store; this is a sanity
    // check that the store has nothing newly added.)
    expect(ctx.oauthStore.consumeCode('arbitrary')).toBeUndefined();
  });

  test('unknown client_id → 400, no form rendered', async () => {
    const ctx = makeCtx();
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: 'cli_unknown',
        redirect_uri: 'http://localhost/cb',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: TEST_API_KEY,
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('mismatched redirect_uri → 400 (cannot inject attacker URL via POST)', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: clientId,
        redirect_uri: 'http://attacker.example.com/cb',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
        state: '',
        scope: '',
        api_key: TEST_API_KEY,
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('redirect_uri with existing query string is preserved alongside ?code=', async () => {
    const ctx = makeCtx();
    await ctx.oauthStore.registerClient({
      clientName: 'Test',
      redirectUris: ['http://localhost:53682/callback?existing=1'],
    });
    const cid = ctx.oauthStore.listClients()[0].clientId;
    const res = await handleAuthorizePost(
      authorizePost({
        client_id: cid,
        redirect_uri: 'http://localhost:53682/callback?existing=1',
        response_type: 'code',
        code_challenge: 'X',
        code_challenge_method: 'S256',
        state: 'S',
        scope: '',
        api_key: TEST_API_KEY,
      }),
      ctx
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('existing')).toBe('1');
    expect(location.searchParams.get('code')).toBeDefined();
    expect(location.searchParams.get('state')).toBe('S');
  });
});

/* ------------------------------------------------------------------ */
/* computeS256Challenge — RFC 7636 reference vector                    */
/* ------------------------------------------------------------------ */

describe('computeS256Challenge', () => {
  test('matches the RFC 7636 Appendix B reference vector', () => {
    // From https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
    // verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    expect(
      computeS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('different verifiers produce different challenges', () => {
    expect(computeS256Challenge('a'.repeat(64))).not.toBe(
      computeS256Challenge('b'.repeat(64))
    );
  });
});

/* ------------------------------------------------------------------ */
/* handleToken — happy path                                            */
/* ------------------------------------------------------------------ */

describe('handleToken — happy path', () => {
  test('valid exchange returns access_token + token_type + expires_in', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code, verifier } = await getAuthCode(ctx);

    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((body.access_token as string).length).toBe(43);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(30 * 24 * 60 * 60);
    expect(body.scope).toBe('mcp');
  });

  test('issued token is findable in the store', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code, verifier } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    const body = (await res.json()) as Record<string, unknown>;
    const t = ctx.oauthStore.findToken(body.access_token as string);
    expect(t).toBeDefined();
    expect(t!.clientId).toBe(clientId);
    expect(t!.scope).toBe('mcp');
  });

  test('the auth code is one-shot — second use of the same code fails', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code, verifier } = await getAuthCode(ctx);

    const first = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(first.status).toBe(200);

    const second = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });
});

/* ------------------------------------------------------------------ */
/* handleToken — adversarial                                           */
/* ------------------------------------------------------------------ */

describe('handleToken — adversarial', () => {
  test('grant_type missing → 400 unsupported_grant_type', async () => {
    const ctx = makeCtx();
    const res = await handleToken(
      tokenPost({ code: 'x', client_id: 'y' }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unsupported_grant_type');
  });

  test('grant_type=password → 400 unsupported_grant_type', async () => {
    const ctx = makeCtx();
    const res = await handleToken(
      tokenPost({ grant_type: 'password' }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unsupported_grant_type');
  });

  test('grant_type=refresh_token → 400 unsupported_grant_type', async () => {
    const ctx = makeCtx();
    const res = await handleToken(
      tokenPost({
        grant_type: 'refresh_token',
        refresh_token: 'doesnt_matter',
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('missing code → 400 invalid_request', async () => {
    const ctx = makeCtx();
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        client_id: 'cli_x',
        redirect_uri: 'http://x/cb',
        code_verifier: 'a'.repeat(64),
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_request');
  });

  test('missing client_id → 400 invalid_request', async () => {
    const ctx = makeCtx();
    const { code, redirectUri, verifier } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('missing redirect_uri → 400 invalid_request', async () => {
    const ctx = makeCtx();
    const { clientId, code, verifier } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('missing code_verifier → 400', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('code_verifier too short (<43 chars) → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: 'a'.repeat(42),
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  test('code_verifier too long (>128 chars) → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: 'a'.repeat(129),
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('code_verifier with disallowed characters → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        // contains '/' which is reserved
        code_verifier: '/'.repeat(64),
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('unknown code → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const clientId = await registerTestClient(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code: 'completely_made_up_code',
        client_id: clientId,
        redirect_uri: 'http://localhost:53682/callback',
        code_verifier: 'a'.repeat(64),
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  test('client_id does not match the one bound to the code → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const { code, redirectUri, verifier } = await getAuthCode(ctx);
    // Register a second client and try to use its id with the first's code.
    const otherClientId = await registerTestClient(
      ctx,
      'http://localhost:53682/callback',
      'Other Client'
    );
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: otherClientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  test('redirect_uri does not match the one used at /authorize → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const { clientId, code, verifier } = await getAuthCode(ctx);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: 'http://different.example.com/cb',
        code_verifier: verifier,
      }),
      ctx
    );
    expect(res.status).toBe(400);
  });

  test('wrong code_verifier (right format, wrong value) → 400 invalid_grant', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code } = await getAuthCode(ctx);
    const wrongVerifier = 'b'.repeat(64);
    const res = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: wrongVerifier,
      }),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');
  });

  test('failed PKCE attempt still consumes the code (one-shot)', async () => {
    const ctx = makeCtx();
    const { clientId, redirectUri, code, verifier } = await getAuthCode(ctx);

    // Attempt #1: wrong verifier — fails AND consumes the code.
    const wrong = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: 'b'.repeat(64),
      }),
      ctx
    );
    expect(wrong.status).toBe(400);

    // Attempt #2: correct verifier — code is already gone.
    const right = await handleToken(
      tokenPost({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      ctx
    );
    expect(right.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* requireBearer                                                       */
/* ------------------------------------------------------------------ */

describe('requireBearer', () => {
  test('valid bearer → ok with the matched token', async () => {
    const ctx = makeCtx();
    const issued = await ctx.oauthStore.issueToken({
      clientId: 'cli_x',
      scope: 'mcp',
    });
    const result = requireBearer(
      new Request('http://localhost:9999/mcp', {
        headers: { authorization: `Bearer ${issued.token}` },
      }),
      ctx
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token!.token).toBe(issued.token);
    }
  });

  test('case-insensitive Bearer scheme', async () => {
    const ctx = makeCtx();
    const issued = await ctx.oauthStore.issueToken({
      clientId: 'cli_x',
      scope: 'mcp',
    });
    const result = requireBearer(
      new Request('http://localhost:9999/mcp', {
        headers: { authorization: `bearer ${issued.token}` },
      }),
      ctx
    );
    expect(result.ok).toBe(true);
  });

  test('missing Authorization header → 401 with WWW-Authenticate', async () => {
    const ctx = makeCtx();
    const result = requireBearer(
      new Request('http://localhost:9999/mcp'),
      ctx
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const wwwAuth = result.response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('Bearer');
      expect(wwwAuth).toContain(
        'resource_metadata="http://localhost:9999/.well-known/oauth-protected-resource"'
      );
    }
  });

  test('Authorization header with non-Bearer scheme → 401', async () => {
    const ctx = makeCtx();
    const result = requireBearer(
      new Request('http://localhost:9999/mcp', {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  test('empty bearer (just "Bearer ") → 401', async () => {
    const ctx = makeCtx();
    const result = requireBearer(
      new Request('http://localhost:9999/mcp', {
        headers: { authorization: 'Bearer ' },
      }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  test('unknown token → 401 with error_description', async () => {
    const ctx = makeCtx();
    const result = requireBearer(
      new Request('http://localhost:9999/mcp', {
        headers: { authorization: 'Bearer this_token_does_not_exist' },
      }),
      ctx
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wwwAuth = result.response.headers.get('www-authenticate');
      expect(wwwAuth).toContain('error="invalid_token"');
    }
  });

  test('revoked token → 401', async () => {
    const ctx = makeCtx();
    const issued = await ctx.oauthStore.issueToken({
      clientId: 'cli_x',
      scope: 'mcp',
    });
    await ctx.oauthStore.revokeToken(issued.token);
    const result = requireBearer(
      new Request('http://localhost:9999/mcp', {
        headers: { authorization: `Bearer ${issued.token}` },
      }),
      ctx
    );
    expect(result.ok).toBe(false);
  });

  test('WWW-Authenticate metadata URL respects Forwarded header', async () => {
    const ctx = makeCtx();
    const result = requireBearer(
      new Request('http://10.0.0.5:9999/mcp', {
        headers: { forwarded: 'proto=https;host=agentio.example.com' },
      }),
      ctx
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const wwwAuth = result.response.headers.get('www-authenticate');
      expect(wwwAuth).toContain(
        'https://agentio.example.com/.well-known/oauth-protected-resource'
      );
    }
  });
});
