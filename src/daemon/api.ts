import type { Server } from 'bun';
import { DAEMON_HOST, DAEMON_PORT, type HealthResponse } from './types';
import { isVaultUnlocked } from '../vault/vault';
import { clientIp } from './rate-limit';
import { handleUiRequest, type UiContext } from './routes-ui';
import { handleV1Request } from './routes-v1';
import { json } from './http';

/** The slice of Bun's Server the handler needs; tests pass a stub. */
export interface PeerSource {
  requestIP(request: Request): { address: string } | null;
}

let server: Server<unknown> | null = null;
let startTime: number = 0;

/**
 * Liveness. Unauthenticated, and 200 whether or not the vault is unlocked so
 * a locked container is not killed before anyone can unlock it.
 */
function handleHealth(): Response {
  const now = Date.now();
  const response: HealthResponse = {
    status: 'ok',
    timestamp: now,
    uptime: now - startTime,
    locked: !isVaultUnlocked(),
  };
  return json(response);
}

export function createRequestHandler(ctx: UiContext) {
  return async (request: Request, peer: PeerSource): Promise<Response> => {
    const path = new URL(request.url).pathname;

    if (path === '/health' && request.method === 'GET') return handleHealth();
    // The domain alone lands on the admin UI; the API lives under /v1 and /health.
    if (path === '/' && request.method === 'GET') return Response.redirect(new URL('/ui', request.url), 302);
    // The domain alone should land on the admin UI, not a JSON 404.
    if (path === '/' && request.method === 'GET') return Response.redirect(new URL('/ui', request.url), 302);

    const ip = clientIp(request, peer.requestIP(request)?.address ?? null);
    const v1 = await handleV1Request(request, ip);
    if (v1) return v1;
    const ui = await handleUiRequest(request, ip, ctx);
    if (ui) return ui;

    return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  };
}

export function startApiServer(ctx: UiContext): void {
  startTime = Date.now();
  const handle = createRequestHandler(ctx);

  server = Bun.serve({
    port: DAEMON_PORT,
    hostname: DAEMON_HOST,
    fetch: (request, srv) => handle(request, srv),
  });

  console.log(`Daemon API listening on ${DAEMON_HOST}:${DAEMON_PORT}`);
  console.log(`Admin UI at http://127.0.0.1:${DAEMON_PORT}/ui`);
}

export function stopApiServer(): void {
  if (server) {
    server.stop();
    server = null;
  }
}
