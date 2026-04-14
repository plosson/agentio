/**
 * OAuth endpoint handlers for the agentio HTTP MCP server. Hand-rolled
 * (no Express, no MCP SDK auth router) so they slot directly into the
 * Bun fetch handler.
 *
 * This file is grown one section at a time across Phase 3c–3g:
 *   - 3c: /.well-known/oauth-protected-resource + /.well-known/oauth-authorization-server
 *   - 3d: POST /register (Dynamic Client Registration)
 *   - 3e: GET/POST /authorize
 *   - 3f: POST /token
 *   - 3g: requireBearer middleware
 */

import { createHash, timingSafeEqual } from 'crypto';

import type { ServerContext } from './http';

/* ------------------------------------------------------------------ */
/* request origin                                                      */
/* ------------------------------------------------------------------ */

/**
 * Compute the origin (scheme://host[:port]) from an incoming Request, with
 * fallbacks for proxies. Used to build absolute URLs in OAuth metadata
 * documents and redirects.
 *
 * Order of precedence:
 *   1. `Forwarded:` header (RFC 7239) — `proto=https;host=foo.example`
 *   2. `X-Forwarded-Proto` + `X-Forwarded-Host` (de facto standard)
 *   3. The Request URL itself (always works for direct HTTP requests)
 *
 * The reason we need this: clients (Claude Code, Cursor) build the
 * authorization URL from the metadata document we serve. If we hardcode
 * `http://localhost:9999`, the client will use that even when reaching us
 * via `https://agentio.example.com`. The metadata MUST advertise the same
 * origin the client used to find it.
 */
export function getRequestOrigin(req: Request): string {
  // 1. RFC 7239 Forwarded
  const forwarded = req.headers.get('forwarded');
  if (forwarded) {
    const parts = Object.fromEntries(
      forwarded
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const [k, ...rest] = p.split('=');
          return [k.toLowerCase(), rest.join('=').replace(/^"|"$/g, '')];
        })
    );
    if (parts.proto && parts.host) {
      return `${parts.proto}://${parts.host}`;
    }
  }

  // 2. X-Forwarded-* (de facto standard)
  const xfProto = req.headers.get('x-forwarded-proto');
  const xfHost = req.headers.get('x-forwarded-host');
  if (xfProto && xfHost) {
    return `${xfProto}://${xfHost}`;
  }

  // 3. The Request URL itself.
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

/* ------------------------------------------------------------------ */
/* metadata documents (Phase 3c)                                       */
/* ------------------------------------------------------------------ */

/**
 * RFC 9728 — Protected Resource Metadata. The first thing a spec-compliant
 * MCP client will fetch when it sees a 401 with
 * `WWW-Authenticate: Bearer resource_metadata=<url>`.
 */
export function buildProtectedResourceMetadata(req: Request): unknown {
  const origin = getRequestOrigin(req);
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  };
}

/**
 * RFC 8414 — Authorization Server Metadata. Tells the client where to do
 * DCR, where to send the user for /authorize, and where to exchange the
 * code at /token.
 */
export function buildAuthorizationServerMetadata(req: Request): unknown {
  const origin = getRequestOrigin(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // public clients
    scopes_supported: ['mcp'],
  };
}

/* ------------------------------------------------------------------ */
/* response helpers                                                    */
/* ------------------------------------------------------------------ */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * RFC 6749 §5.2 / RFC 7591 §3.2.2 OAuth error response shape.
 */
export function oauthErrorResponse(
  error:
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'invalid_scope'
    | 'invalid_redirect_uri'
    | 'invalid_client_metadata'
    | 'server_error',
  description?: string,
  status = 400
): Response {
  return jsonResponse(
    {
      error,
      ...(description ? { error_description: description } : {}),
    },
    status
  );
}

/* ------------------------------------------------------------------ */
/* Dynamic Client Registration — POST /register (Phase 3d)             */
/* ------------------------------------------------------------------ */

/**
 * RFC 7591 client registration. Accepts:
 *   {
 *     "client_name": "Claude Code",
 *     "redirect_uris": ["http://localhost:53682/callback"]
 *   }
 *
 * The current implementation is permissive: any caller can register, no
 * software_statement, no `initial_access_token`. That's correct for a
 * single-user server where the only thing protecting tool access is the
 * API key gate at /authorize. The mere act of registering does not grant
 * any access — DCR is just the bookkeeping that lets us bind tokens to a
 * stable client identity afterwards.
 */
export async function handleRegister(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthErrorResponse(
      'invalid_client_metadata',
      'request body must be valid JSON'
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return oauthErrorResponse(
      'invalid_client_metadata',
      'request body must be a JSON object'
    );
  }

  const obj = body as Record<string, unknown>;

  // redirect_uris is REQUIRED per RFC 7591 §2 for clients that use the
  // authorization code flow. We always do, so we always require it.
  const rawRedirectUris = obj.redirect_uris;
  if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0) {
    return oauthErrorResponse(
      'invalid_redirect_uri',
      'redirect_uris must be a non-empty array of URI strings'
    );
  }

  const redirectUris: string[] = [];
  for (const uri of rawRedirectUris) {
    if (typeof uri !== 'string' || uri.length === 0) {
      return oauthErrorResponse(
        'invalid_redirect_uri',
        'each redirect_uri must be a non-empty string'
      );
    }
    // Basic URL parse — rejects garbage like "javascript:..."? No: URL
    // accepts those. Filter explicitly.
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return oauthErrorResponse(
        'invalid_redirect_uri',
        `redirect_uri is not a valid URL: ${uri}`
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return oauthErrorResponse(
        'invalid_redirect_uri',
        `redirect_uri scheme must be http or https, got ${parsed.protocol}`
      );
    }
    redirectUris.push(uri);
  }

  // client_name is OPTIONAL.
  const rawClientName = obj.client_name;
  let clientName: string | undefined;
  if (rawClientName !== undefined) {
    if (typeof rawClientName !== 'string') {
      return oauthErrorResponse(
        'invalid_client_metadata',
        'client_name must be a string when provided'
      );
    }
    if (rawClientName.length > 200) {
      return oauthErrorResponse(
        'invalid_client_metadata',
        'client_name must be ≤200 characters'
      );
    }
    clientName = rawClientName;
  }

  const client = await ctx.oauthStore.registerClient({
    clientName,
    redirectUris,
  });

  // RFC 7591 §3.2.1 success response.
  return jsonResponse(
    {
      client_id: client.clientId,
      ...(client.clientName ? { client_name: client.clientName } : {}),
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(client.createdAt / 1000),
    },
    201
  );
}

/* ------------------------------------------------------------------ */
/* Authorization endpoint — GET/POST /authorize (Phase 3e)             */
/* ------------------------------------------------------------------ */

/**
 * Constant-time string compare. Both strings are converted to UTF-8 byte
 * buffers; mismatched lengths short-circuit but only after a dummy compare
 * of equal length to keep the timing flat.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against itself so the work is the same regardless of which
    // input is longer.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Minimal HTML escape for user-controlled values rendered into the form
 * (state, client_name, error message). We don't reflect arbitrary user
 * input as raw HTML anywhere.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate the OAuth authorize-request parameters that both GET (form
 * render) and POST (form submission) need to check. Returns either an
 * error Response (to be returned directly) or a normalized params object.
 */
interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  responseType: string;
}

function readAuthorizeParams(
  source: URLSearchParams,
  ctx: ServerContext
): { ok: true; params: AuthorizeParams } | { ok: false; response: Response } {
  const clientId = source.get('client_id') ?? '';
  const redirectUri = source.get('redirect_uri') ?? '';
  const state = source.get('state') ?? '';
  const codeChallenge = source.get('code_challenge') ?? '';
  const codeChallengeMethod = source.get('code_challenge_method') ?? '';
  const responseType = source.get('response_type') ?? '';
  const scope = source.get('scope') ?? '';

  if (!clientId) {
    return {
      ok: false,
      response: oauthErrorResponse('invalid_request', 'client_id is required'),
    };
  }

  const client = ctx.oauthStore.findClient(clientId);
  if (!client) {
    return {
      ok: false,
      response: oauthErrorResponse('invalid_client', 'unknown client_id'),
    };
  }

  if (!redirectUri) {
    return {
      ok: false,
      response: oauthErrorResponse(
        'invalid_request',
        'redirect_uri is required'
      ),
    };
  }

  if (!client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      response: oauthErrorResponse(
        'invalid_request',
        'redirect_uri does not match any registered URI for this client'
      ),
    };
  }

  if (responseType !== 'code') {
    return {
      ok: false,
      response: oauthErrorResponse(
        'invalid_request',
        'response_type must be "code"'
      ),
    };
  }

  if (!codeChallenge) {
    return {
      ok: false,
      response: oauthErrorResponse(
        'invalid_request',
        'code_challenge is required (PKCE)'
      ),
    };
  }

  if (codeChallengeMethod !== 'S256') {
    return {
      ok: false,
      response: oauthErrorResponse(
        'invalid_request',
        'code_challenge_method must be "S256"'
      ),
    };
  }

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      scope,
      responseType,
    },
  };
}

/**
 * Render the API key entry form. The HTML is plain inline CSS; no template
 * engine, no client-side JS. The form posts back to /authorize with all
 * the OAuth params preserved as hidden inputs.
 */
function renderAuthorizeForm(args: {
  params: AuthorizeParams;
  clientName?: string;
  errorMessage?: string;
}): Response {
  const { params, clientName, errorMessage } = args;
  const errorBlock = errorMessage
    ? `<p class="error">${escapeHtml(errorMessage)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize agentio MCP access</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-width: 480px;
    margin: 8vh auto;
    padding: 0 24px;
    line-height: 1.5;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.4rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .meta strong { color: inherit; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-weight: 600; }
  input[type=password] {
    padding: 0.6rem 0.75rem;
    font-size: 1rem;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    border: 1px solid #888;
    border-radius: 6px;
  }
  button {
    padding: 0.6rem 1rem;
    font-size: 1rem;
    font-weight: 600;
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  .error {
    background: #fee;
    color: #900;
    padding: 0.6rem 0.75rem;
    border-radius: 6px;
    border: 1px solid #fcc;
    margin: 0;
  }
  .scope { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Authorize MCP access</h1>
<p class="meta">
  <strong>${escapeHtml(clientName ?? 'An MCP client')}</strong>
  is requesting access to your agentio server.
</p>
${
  params.scope
    ? `<p class="meta">Requested services: <span class="scope">${escapeHtml(
        params.scope
      )}</span></p>`
    : ''
}
${errorBlock}
<form method="post" action="/authorize">
  <label for="api_key">agentio API key</label>
  <input id="api_key" name="api_key" type="password" autocomplete="off" autofocus required>
  <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
  <input type="hidden" name="state" value="${escapeHtml(params.state)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
  <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
  <input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}">
  <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
  <button type="submit">Authorize</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * GET /authorize — render the API key form. Validates OAuth params first
 * so we never render a form that we wouldn't be able to satisfy on POST.
 */
export async function handleAuthorizeGet(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  const url = new URL(req.url);
  const result = readAuthorizeParams(url.searchParams, ctx);
  if (!result.ok) return result.response;

  const client = ctx.oauthStore.findClient(result.params.clientId);
  return renderAuthorizeForm({
    params: result.params,
    clientName: client?.clientName,
  });
}

/**
 * POST /authorize — validate the API key and (on success) issue a one-time
 * code, then 302 to the client's redirect_uri.
 */
export async function handleAuthorizePost(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  // Form data per HTML5; content-type should be
  // application/x-www-form-urlencoded.
  let form: URLSearchParams;
  try {
    const body = await req.text();
    form = new URLSearchParams(body);
  } catch {
    return oauthErrorResponse('invalid_request', 'failed to parse form body');
  }

  const result = readAuthorizeParams(form, ctx);
  if (!result.ok) return result.response;

  const params = result.params;
  const client = ctx.oauthStore.findClient(params.clientId);
  const apiKey = form.get('api_key') ?? '';

  if (!apiKey || !constantTimeEquals(apiKey, ctx.apiKey)) {
    // Re-render the form with an error. We deliberately do NOT redirect
    // back to the client on bad-credential failure — the user needs to
    // fix the API key in the form, not navigate away.
    return renderAuthorizeForm({
      params,
      clientName: client?.clientName,
      errorMessage: 'Invalid API key. Check your agentio server terminal.',
    });
  }

  // API key matched — issue a code and redirect.
  const code = ctx.oauthStore.createCode({
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    scope: params.scope,
  });

  const redirectUrl = new URL(params.redirectUri);
  redirectUrl.searchParams.set('code', code.code);
  if (params.state) {
    redirectUrl.searchParams.set('state', params.state);
  }

  return new Response(null, {
    status: 302,
    headers: { location: redirectUrl.toString() },
  });
}

/* ------------------------------------------------------------------ */
/* Token endpoint — POST /token (Phase 3f)                             */
/* ------------------------------------------------------------------ */

/**
 * Compute the PKCE S256 code_challenge from a code_verifier per RFC 7636
 * §4.2: BASE64URL(SHA256(verifier)). The verifier is treated as ASCII for
 * hashing purposes, which matches the spec.
 */
export function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * POST /token — exchange an authorization code for a bearer token.
 *
 * Requires `grant_type=authorization_code`. Validates the code exists,
 * isn't expired (handled inside consumeCode), the client_id matches the
 * one bound to the code, the redirect_uri matches, and the code_verifier
 * S256-hashes to the stored code_challenge.
 *
 * Refresh tokens are deliberately NOT issued — single-user server, 30-day
 * access token lifetime, refresh adds protocol surface for no benefit.
 */
export async function handleToken(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  let form: URLSearchParams;
  try {
    const body = await req.text();
    form = new URLSearchParams(body);
  } catch {
    return oauthErrorResponse('invalid_request', 'failed to parse form body');
  }

  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code') {
    return oauthErrorResponse(
      'unsupported_grant_type',
      'only authorization_code is supported'
    );
  }

  const code = form.get('code') ?? '';
  const clientId = form.get('client_id') ?? '';
  const redirectUri = form.get('redirect_uri') ?? '';
  const codeVerifier = form.get('code_verifier') ?? '';

  if (!code) return oauthErrorResponse('invalid_request', 'code is required');
  if (!clientId)
    return oauthErrorResponse('invalid_request', 'client_id is required');
  if (!redirectUri)
    return oauthErrorResponse('invalid_request', 'redirect_uri is required');
  if (!codeVerifier)
    return oauthErrorResponse(
      'invalid_request',
      'code_verifier is required (PKCE)'
    );

  // Per RFC 7636 §4.1: code_verifier = 43..128 unreserved characters.
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return oauthErrorResponse(
      'invalid_grant',
      'code_verifier length must be between 43 and 128 characters'
    );
  }
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
    return oauthErrorResponse(
      'invalid_grant',
      'code_verifier contains invalid characters'
    );
  }

  // consumeCode is one-shot: a successful exchange (or any retry, even
  // a failed one with the right code) deletes the code from the store.
  const stored = ctx.oauthStore.consumeCode(code);
  if (!stored) {
    return oauthErrorResponse(
      'invalid_grant',
      'code is unknown, expired, or already used'
    );
  }

  if (stored.clientId !== clientId) {
    return oauthErrorResponse(
      'invalid_grant',
      'code was issued to a different client'
    );
  }

  if (stored.redirectUri !== redirectUri) {
    return oauthErrorResponse(
      'invalid_grant',
      'redirect_uri does not match the one used at /authorize'
    );
  }

  // PKCE verification: SHA256(verifier) base64url-encoded must equal the
  // stored challenge.
  const computedChallenge = computeS256Challenge(codeVerifier);
  if (!constantTimeEquals(computedChallenge, stored.codeChallenge)) {
    return oauthErrorResponse(
      'invalid_grant',
      'code_verifier does not match code_challenge'
    );
  }

  // All checks passed — issue a bearer token.
  const issued = await ctx.oauthStore.issueToken({
    clientId: stored.clientId,
    scope: stored.scope,
  });

  return jsonResponse({
    access_token: issued.token,
    token_type: 'Bearer',
    expires_in: Math.floor((issued.expiresAt - issued.issuedAt) / 1000),
    scope: issued.scope,
  });
}

/* ------------------------------------------------------------------ */
/* Bearer middleware (Phase 3g)                                        */
/* ------------------------------------------------------------------ */

/**
 * Build a 401 response with `WWW-Authenticate: Bearer` pointing at the
 * resource metadata document. This is what triggers an MCP client's
 * discovery → DCR → OAuth flow on the very first request to /mcp. Without
 * the WWW-Authenticate header most clients just show "401 Unauthorized"
 * and refuse to add the server.
 */
function unauthorizedResponse(req: Request, error?: string): Response {
  const origin = getRequestOrigin(req);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const errPart = error ? `, error="invalid_token"` : '';
  return new Response(
    JSON.stringify({
      error: 'unauthorized',
      ...(error ? { error_description: error } : {}),
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${metadataUrl}"${errPart}`,
      },
    }
  );
}

/**
 * Validate the Authorization: Bearer header on a request. Returns either
 * the matched ServerToken (so the caller can read its scope) or a 401
 * Response that the caller should return directly.
 */
export function requireBearer(
  req: Request,
  ctx: ServerContext
): { ok: true; token: ReturnType<typeof ctx.oauthStore.findToken> } | {
  ok: false;
  response: Response;
} {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return { ok: false, response: unauthorizedResponse(req) };
  }
  const tokenValue = auth.slice(7).trim();
  if (!tokenValue) {
    return { ok: false, response: unauthorizedResponse(req) };
  }
  const token = ctx.oauthStore.findToken(tokenValue);
  if (!token) {
    return {
      ok: false,
      response: unauthorizedResponse(req, 'token is unknown or expired'),
    };
  }
  return { ok: true, token };
}

/* ------------------------------------------------------------------ */
/* route table entry points                                            */
/* ------------------------------------------------------------------ */

/**
 * Top-level OAuth router. Returns `null` if the request doesn't match any
 * OAuth-managed path, so the main `handleRequest` can fall through to its
 * other routes (and ultimately the 404 handler).
 */
export async function routeOAuth(
  req: Request,
  ctx: ServerContext
): Promise<Response | null> {
  const url = new URL(req.url);

  if (
    req.method === 'GET' &&
    url.pathname === '/.well-known/oauth-protected-resource'
  ) {
    return jsonResponse(buildProtectedResourceMetadata(req));
  }

  if (
    req.method === 'GET' &&
    url.pathname === '/.well-known/oauth-authorization-server'
  ) {
    return jsonResponse(buildAuthorizationServerMetadata(req));
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    return handleRegister(req, ctx);
  }

  if (url.pathname === '/authorize') {
    if (req.method === 'GET') return handleAuthorizeGet(req, ctx);
    if (req.method === 'POST') return handleAuthorizePost(req, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    return handleToken(req, ctx);
  }

  return null;
}
