import type { Server } from 'bun';
import type { HealthResponse } from './types';
import type { DaemonConfig } from '../types/config';
import { loadConfig } from '../config/config-manager';
import { listSchedulerJobs, runOneJob, reloadScheduler } from './scheduler';

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

  if (request.method === 'GET') {
    if (path === '/scheduler/list') {
      const allHosts = url.searchParams.get('all') === '1';
      const jobs = await listSchedulerJobs({ allHosts });
      return Response.json({ jobs });
    }
  }

  if (request.method === 'POST' && path === '/scheduler/run') {
    const body = await request.json() as { folder?: string; id?: string };
    if (!body.folder || !body.id) return new Response('missing folder or id', { status: 400 });
    const result = await runOneJob(body.folder, body.id);
    return Response.json(result);
  }

  if (request.method === 'POST' && path === '/scheduler/reload') {
    const config = await loadConfig();
    const folders = config.daemon?.scheduler?.watchedFolders ?? [];
    await reloadScheduler(folders);
    return Response.json({ folders: folders.length });
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
