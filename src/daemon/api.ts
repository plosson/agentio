import type { Server } from 'bun';
import type { HealthResponse } from './types';
import type { DaemonConfig } from '../types/config';

let server: Server<unknown> | null = null;
let apiKey: string = '';
let startTime: number = 0;

/**
 * JSON error response helper
 */
function jsonError(message: string, status: number = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify X-API-Key header
 */
function verifyAuth(request: Request): boolean {
  if (!apiKey) return true; // No auth configured

  const key = request.headers.get('X-API-Key');
  return key === apiKey;
}

/**
 * Handle health check
 */
function handleHealth(): Response {
  const response: HealthResponse = { status: 'ok', timestamp: Date.now() };
  return new Response(JSON.stringify({ ...response, uptime: Date.now() - startTime }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Main request handler
 */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // Health check doesn't require auth
  if (path === '/health' && request.method === 'GET') {
    return handleHealth();
  }

  // All other endpoints require auth
  if (!verifyAuth(request)) {
    return jsonError('Unauthorized', 401);
  }

  return jsonError('Not found', 404);
}

/**
 * Start the API server
 */
export function startApiServer(config: DaemonConfig): Server<unknown> {
  const port = config?.server?.port ?? 7890;
  const host = config?.server?.host ?? '0.0.0.0';
  apiKey = config?.apiKey ?? '';
  startTime = Date.now();

  server = Bun.serve({
    port,
    hostname: host,
    fetch: handleRequest,
  });

  console.log(`Daemon API listening on http://${host}:${port}`);
  return server;
}

/**
 * Stop the API server
 */
export function stopApiServer(): void {
  if (server) {
    server.stop();
    server = null;
  }
}

/**
 * Check if server is running
 */
export function isApiServerRunning(): boolean {
  return server !== null;
}
