import type { Server } from 'bun';
import { DAEMON_HOST, DAEMON_PORT, type HealthResponse } from './types';
import { isVaultUnlocked } from '../vault/vault';

let server: Server<unknown> | null = null;
let startTime: number = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

function handleRequest(request: Request): Response {
  const path = new URL(request.url).pathname;

  if (path === '/health' && request.method === 'GET') {
    return handleHealth();
  }

  return json({ error: 'Not found' }, 404);
}

export function startApiServer(): void {
  startTime = Date.now();

  server = Bun.serve({
    port: DAEMON_PORT,
    hostname: DAEMON_HOST,
    fetch: handleRequest,
  });

  console.log(`Daemon API listening on http://${DAEMON_HOST}:${DAEMON_PORT}`);
}

export function stopApiServer(): void {
  if (server) {
    server.stop();
    server = null;
  }
}
