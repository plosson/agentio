import type { Server } from 'bun';
import type { HealthResponse } from './types';
import { isVaultUnlocked } from '../vault/vault';

/** Fixed bind: the daemon runs in a container, so the port is mapped there. */
export const DAEMON_HOST = '0.0.0.0';
export const DAEMON_PORT = 7890;

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
  const response: HealthResponse = {
    status: 'ok',
    timestamp: Date.now(),
    uptime: Date.now() - startTime,
    locked: !isVaultUnlocked(),
  };
  return json(response);
}

async function handleRequest(request: Request): Promise<Response> {
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
