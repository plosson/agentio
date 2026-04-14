import { handleMcpRequest } from './mcp-http';
import type { OAuthStore } from './oauth-store';
import { requireBearer, routeOAuth } from './oauth';

/**
 * Context passed to every fetch handler invocation. Built once at boot in
 * `daemon.ts` and closed-over by the Bun.serve fetch callback.
 */
export interface ServerContext {
  /** Operator API key — gates the /authorize POST endpoint in Phase 3. */
  apiKey: string;
  /** Persistent OAuth state (clients, tokens) + in-memory codes. */
  oauthStore: OAuthStore;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The single entry point used by `Bun.serve`. Routes to per-endpoint
 * handlers based on `URL.pathname`. Phase 2 only wires `/health` and a
 * catch-all 404; Phase 3 will add the OAuth + bearer-protected routes.
 */
export async function handleRequest(
  req: Request,
  ctx: ServerContext
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    return jsonResponse({ ok: true });
  }

  // OAuth metadata + endpoints (Phase 3c onward).
  const oauthResponse = await routeOAuth(req, ctx);
  if (oauthResponse) return oauthResponse;

  // /mcp — bearer-protected Streamable HTTP MCP transport.
  // Bearer auth runs first so unauthorized requests get a clean 401 with
  // WWW-Authenticate (triggering the client's OAuth flow) rather than an
  // opaque MCP error. After auth, the request is forwarded to the
  // per-session transport managed in mcp-http.ts.
  if (url.pathname === '/mcp') {
    const auth = requireBearer(req, ctx);
    if (!auth.ok) return auth.response;
    return handleMcpRequest(req);
  }

  return jsonResponse({ error: 'not found' }, 404);
}
