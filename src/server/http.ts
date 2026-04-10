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

  // /mcp — bearer-protected. Phase 3 only ships a stub body; Phase 4 will
  // replace this with the Streamable HTTP MCP transport.
  if (url.pathname === '/mcp') {
    const auth = requireBearer(req, ctx);
    if (!auth.ok) return auth.response;
    return jsonResponse({
      phase: 3,
      message:
        'MCP transport not yet implemented; bearer auth verified successfully.',
      scope: auth.token!.scope,
      clientId: auth.token!.clientId,
    });
  }

  return jsonResponse({ error: 'not found' }, 404);
}
