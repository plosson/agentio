import type { Server } from 'bun';
import type { ServiceName } from '../types/config';
import type {
  GatewayConfig,
  InboxPullRequest,
  InboxPullResponse,
  InboxGetRequest,
  InboxGetResponse,
  InboxAckRequest,
  InboxAckResponse,
  InboxReplyRequest,
  InboxReplyResponse,
  InboxStatsRequest,
  InboxStatsResponse,
  OutboxSendRequest,
  OutboxSendResponse,
  OutboxStatusRequest,
  OutboxStatusResponse,
  OutboxListRequest,
  OutboxListResponse,
  GatewayStatusResponse,
  HealthResponse,
  WhatsAppPairResponse,
} from './types';
import { DEFAULT_GATEWAY_CONFIG } from './types';
import {
  getInboxMessages,
  getInboxMessage,
  ackInboxMessage,
  getInboxStats,
  queueOutboxMessage,
  getOutboxMessage,
  getOutboxMessages,
  importWhatsAppAuthState,
  type WhatsAppAuthExport,
} from './store';
import type { ServiceAdapter } from './adapters/types';
import type { WhatsAppAdapter } from './adapters/whatsapp';

let server: Server<unknown> | null = null;
let apiSecret: string = '';
let startTime: number = 0;
let adapters: Map<ServiceName, ServiceAdapter> = new Map();

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
 * JSON success response helper
 */
function jsonResponse<T>(data: T, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify authorization header
 */
function verifyAuth(request: Request): boolean {
  if (!apiSecret) return true; // No auth configured

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;

  const [type, token] = authHeader.split(' ');
  return type === 'Bearer' && token === apiSecret;
}

/**
 * Parse JSON body safely
 */
async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
}

/**
 * Handle inbox pull request
 */
async function handleInboxPull(request: Request): Promise<Response> {
  const body = await parseJsonBody<InboxPullRequest>(request);

  const messages = getInboxMessages({
    service: body?.service,
    profile: body?.profile,
    status: body?.status ?? 'pending',
    limit: body?.limit ?? 50,
  });

  const response: InboxPullResponse = { messages };
  return jsonResponse(response);
}

/**
 * Handle inbox get request
 */
async function handleInboxGet(request: Request): Promise<Response> {
  const body = await parseJsonBody<InboxGetRequest>(request);

  if (!body?.id) {
    return jsonError('Message ID is required');
  }

  const message = getInboxMessage(body.id);
  const response: InboxGetResponse = { message };
  return jsonResponse(response);
}

/**
 * Handle inbox ack request
 */
async function handleInboxAck(request: Request): Promise<Response> {
  const body = await parseJsonBody<InboxAckRequest>(request);

  if (!body?.id) {
    return jsonError('Message ID is required');
  }

  const success = ackInboxMessage(body.id);
  const response: InboxAckResponse = { success };
  return jsonResponse(response);
}

/**
 * Handle inbox reply request
 */
async function handleInboxReply(request: Request): Promise<Response> {
  const body = await parseJsonBody<InboxReplyRequest>(request);

  if (!body?.id) {
    return jsonError('Message ID is required');
  }
  if (!body?.content) {
    return jsonError('Content is required');
  }

  // Get the original inbox message
  const inboxMessage = getInboxMessage(body.id);
  if (!inboxMessage) {
    return jsonError('Message not found', 404);
  }

  // Queue reply to outbox
  const outboxMessage = queueOutboxMessage({
    service: inboxMessage.service,
    profile: inboxMessage.profile,
    conversationId: inboxMessage.conversationId,
    content: body.content,
    mediaPath: body.mediaPath,
    mediaType: body.mediaType,
    replyToPlatformId: inboxMessage.platformId,
  });

  // Auto-ack the inbox message
  ackInboxMessage(body.id);

  const response: InboxReplyResponse = {
    outboxId: outboxMessage.id,
    status: outboxMessage.status,
  };
  return jsonResponse(response);
}

/**
 * Handle inbox stats request
 */
async function handleInboxStats(request: Request): Promise<Response> {
  const body = await parseJsonBody<InboxStatsRequest>(request);

  const stats = getInboxStats({
    service: body?.service,
    profile: body?.profile,
  });

  const response: InboxStatsResponse = stats;
  return jsonResponse(response);
}

/**
 * Handle outbox send request
 */
async function handleOutboxSend(request: Request): Promise<Response> {
  const body = await parseJsonBody<OutboxSendRequest>(request);

  if (!body?.service) {
    return jsonError('Service is required');
  }
  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.conversationId) {
    return jsonError('Conversation ID is required');
  }
  if (!body?.content && !body?.mediaPath) {
    return jsonError('Content or media is required');
  }

  const outboxMessage = queueOutboxMessage({
    service: body.service,
    profile: body.profile,
    conversationId: body.conversationId,
    content: body.content,
    mediaPath: body.mediaPath,
    mediaType: body.mediaType,
    replyToPlatformId: body.replyToPlatformId,
    metadata: body.metadata,
  });

  const response: OutboxSendResponse = {
    id: outboxMessage.id,
    status: outboxMessage.status,
  };
  return jsonResponse(response);
}

/**
 * Handle outbox status request
 */
async function handleOutboxStatus(request: Request): Promise<Response> {
  const body = await parseJsonBody<OutboxStatusRequest>(request);

  if (!body?.id) {
    return jsonError('Message ID is required');
  }

  const message = getOutboxMessage(body.id);
  const response: OutboxStatusResponse = { message };
  return jsonResponse(response);
}

/**
 * Handle outbox list request
 */
async function handleOutboxList(request: Request): Promise<Response> {
  const body = await parseJsonBody<OutboxListRequest>(request);

  const messages = getOutboxMessages({
    service: body?.service,
    profile: body?.profile,
    status: body?.status,
    limit: body?.limit ?? 50,
  });

  const response: OutboxListResponse = { messages };
  return jsonResponse(response);
}

/**
 * Handle health check
 */
function handleHealth(): Response {
  const response: HealthResponse = {
    status: 'ok',
    timestamp: Math.floor(Date.now() / 1000),
  };
  return jsonResponse(response);
}

/**
 * Handle gateway status
 */
function handleStatus(): Response {
  const adapterStatus: GatewayStatusResponse['adapters'] = [];

  for (const [service, adapter] of adapters) {
    for (const profile of adapter.getConnectedProfiles()) {
      const state = adapter.getConnectionState(profile);
      adapterStatus.push({
        service,
        profile,
        connected: state.connected,
        error: state.error,
      });
    }
  }

  const response: GatewayStatusResponse = {
    running: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    adapters: adapterStatus,
  };
  return jsonResponse(response);
}

/**
 * Handle media request
 */
function handleMedia(id: string): Response {
  const message = getInboxMessage(id);
  if (!message) {
    return jsonError('Message not found', 404);
  }
  if (!message.mediaPath) {
    return jsonError('No media attached', 404);
  }

  try {
    const file = Bun.file(message.mediaPath);
    return new Response(file);
  } catch {
    return jsonError('Media file not found', 404);
  }
}

/**
 * Handle WhatsApp pairing request
 */
function handleWhatsAppPair(profile: string): Response {
  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;

  if (!whatsappAdapter) {
    const response: WhatsAppPairResponse = {
      status: 'not_configured',
      message: 'WhatsApp is not configured. Add a profile first.',
    };
    return jsonResponse(response);
  }

  const state = whatsappAdapter.getWhatsAppState(profile);

  if (state.connected) {
    const response: WhatsAppPairResponse = {
      status: 'connected',
      phoneNumber: state.phoneNumber,
      displayName: undefined, // Will be filled if available
      message: `Connected as ${state.phoneNumber || 'WhatsApp user'}`,
    };
    return jsonResponse(response);
  }

  if (state.qrCode) {
    const response: WhatsAppPairResponse = {
      status: 'waiting_qr',
      qrCode: state.qrCode,
      message: 'Scan QR code with WhatsApp on your phone',
    };
    return jsonResponse(response);
  }

  const response: WhatsAppPairResponse = {
    status: 'connecting',
    message: state.error || 'Connecting to WhatsApp...',
  };
  return jsonResponse(response);
}

/**
 * Handle WhatsApp auth import (for teleport)
 */
async function handleWhatsAppImport(profile: string, request: Request): Promise<Response> {
  try {
    const authExport = await parseJsonBody<WhatsAppAuthExport>(request);

    if (!authExport || !authExport.profile) {
      return jsonError('Invalid auth export data');
    }

    // Import the auth state
    await importWhatsAppAuthState({
      ...authExport,
      profile, // Use URL profile, not body profile (security)
    });

    // Disconnect and reconnect WhatsApp adapter to use new credentials
    const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
    if (whatsappAdapter) {
      await whatsappAdapter.disconnect(profile);
      // Note: reconnection will happen on next daemon cycle or manual reload
    }

    return jsonResponse({ success: true, message: 'Auth state imported. Reload gateway to reconnect.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed';
    return jsonError(message, 500);
  }
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

  // Route requests
  if (request.method === 'GET') {
    if (path === '/status') return handleStatus();
    if (path.startsWith('/media/')) {
      const id = path.slice('/media/'.length);
      return handleMedia(id);
    }
    if (path.startsWith('/whatsapp/pair/')) {
      const profile = decodeURIComponent(path.slice('/whatsapp/pair/'.length));
      return handleWhatsAppPair(profile);
    }
  }

  if (request.method === 'POST') {
    if (path === '/inbox/pull') return handleInboxPull(request);
    if (path === '/inbox/get') return handleInboxGet(request);
    if (path === '/inbox/ack') return handleInboxAck(request);
    if (path === '/inbox/reply') return handleInboxReply(request);
    if (path === '/inbox/stats') return handleInboxStats(request);
    if (path === '/outbox/send') return handleOutboxSend(request);
    if (path === '/outbox/status') return handleOutboxStatus(request);
    if (path === '/outbox/list') return handleOutboxList(request);
    // Teleport import endpoints
    if (path.startsWith('/import/whatsapp/')) {
      const profile = decodeURIComponent(path.slice('/import/whatsapp/'.length));
      return handleWhatsAppImport(profile, request);
    }
  }

  return jsonError('Not found', 404);
}

/**
 * Start the API server
 */
export function startApiServer(config: GatewayConfig['api'], serviceAdapters: Map<ServiceName, ServiceAdapter>): Server<unknown> {
  const port = config?.port ?? DEFAULT_GATEWAY_CONFIG.api.port;
  const host = config?.host ?? DEFAULT_GATEWAY_CONFIG.api.host;
  apiSecret = config?.secret ?? '';
  startTime = Date.now();
  adapters = serviceAdapters;

  server = Bun.serve({
    port,
    hostname: host,
    fetch: handleRequest,
  });

  console.log(`Gateway API listening on http://${host}:${port}`);
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
