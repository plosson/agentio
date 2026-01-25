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
  WhatsAppGroupListRequest,
  WhatsAppGroupListResponse,
  WhatsAppGroupGetRequest,
  WhatsAppGroupGetResponse,
  WhatsAppGroupCreateRequest,
  WhatsAppGroupCreateResponse,
  WhatsAppGroupUpdateRequest,
  WhatsAppGroupUpdateResponse,
  WhatsAppGroupParticipantsRequest,
  WhatsAppGroupParticipantsResponse,
  WhatsAppGroupLeaveRequest,
  WhatsAppGroupLeaveResponse,
  WhatsAppGroupInviteRequest,
  WhatsAppGroupInviteResponse,
  WhatsAppGroupJoinRequest,
  WhatsAppGroupJoinResponse,
  WhatsAppGroupResolveRequest,
  WhatsAppGroupResolveResponse,
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
    conversationId: body?.conversationId,
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

// ============ WHATSAPP GROUP HANDLERS ============

/**
 * Handle WhatsApp group list request
 */
async function handleWhatsAppGroupList(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupListRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const groups = await whatsappAdapter.listGroups(body.profile);
    const response: WhatsAppGroupListResponse = { groups };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list groups';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group get request
 */
async function handleWhatsAppGroupGet(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupGetRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.groupId) {
    return jsonError('Group ID is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const group = await whatsappAdapter.getGroup(body.profile, body.groupId);
    const response: WhatsAppGroupGetResponse = { group };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get group';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group create request
 */
async function handleWhatsAppGroupCreate(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupCreateRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.name) {
    return jsonError('Group name is required');
  }
  if (!body?.participants || body.participants.length === 0) {
    return jsonError('At least one participant is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const group = await whatsappAdapter.createGroup(body.profile, body.name, body.participants);
    const response: WhatsAppGroupCreateResponse = { group };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create group';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group update request
 */
async function handleWhatsAppGroupUpdate(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupUpdateRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.groupId) {
    return jsonError('Group ID is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    if (body.subject) {
      await whatsappAdapter.updateGroupSubject(body.profile, body.groupId, body.subject);
    }
    if (body.description !== undefined) {
      await whatsappAdapter.updateGroupDescription(body.profile, body.groupId, body.description);
    }
    const response: WhatsAppGroupUpdateResponse = { success: true };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update group';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group participants update request
 */
async function handleWhatsAppGroupParticipants(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupParticipantsRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.groupId) {
    return jsonError('Group ID is required');
  }
  if (!body?.participants || body.participants.length === 0) {
    return jsonError('At least one participant is required');
  }
  if (!body?.action) {
    return jsonError('Action is required (add, remove, promote, demote)');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const results = await whatsappAdapter.updateParticipants(
      body.profile,
      body.groupId,
      body.participants,
      body.action
    );
    const response: WhatsAppGroupParticipantsResponse = { success: true, results };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update participants';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group leave request
 */
async function handleWhatsAppGroupLeave(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupLeaveRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.groupId) {
    return jsonError('Group ID is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    await whatsappAdapter.leaveGroup(body.profile, body.groupId);
    const response: WhatsAppGroupLeaveResponse = { success: true };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to leave group';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group invite code request
 */
async function handleWhatsAppGroupInvite(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupInviteRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.groupId) {
    return jsonError('Group ID is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const inviteCode = await whatsappAdapter.getGroupInviteCode(body.profile, body.groupId);
    const response: WhatsAppGroupInviteResponse = {
      inviteCode,
      inviteLink: `https://chat.whatsapp.com/${inviteCode}`,
    };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get invite code';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group join request
 */
async function handleWhatsAppGroupJoin(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupJoinRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.inviteCode) {
    return jsonError('Invite code is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const groupId = await whatsappAdapter.joinGroupViaInvite(body.profile, body.inviteCode);
    const response: WhatsAppGroupJoinResponse = { groupId };
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to join group';
    return jsonError(message, 500);
  }
}

/**
 * Handle WhatsApp group resolve request (name to JID or JID to name)
 */
async function handleWhatsAppGroupResolve(request: Request): Promise<Response> {
  const body = await parseJsonBody<WhatsAppGroupResolveRequest>(request);

  if (!body?.profile) {
    return jsonError('Profile is required');
  }
  if (!body?.nameOrId) {
    return jsonError('Name or ID is required');
  }

  const whatsappAdapter = adapters.get('whatsapp') as WhatsAppAdapter | undefined;
  if (!whatsappAdapter) {
    return jsonError('WhatsApp not configured', 404);
  }

  try {
    const result = await whatsappAdapter.resolveGroup(body.profile, body.nameOrId);
    const response: WhatsAppGroupResolveResponse = result;
    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve group';
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
    // WhatsApp group endpoints
    if (path === '/whatsapp/groups/list') return handleWhatsAppGroupList(request);
    if (path === '/whatsapp/groups/get') return handleWhatsAppGroupGet(request);
    if (path === '/whatsapp/groups/create') return handleWhatsAppGroupCreate(request);
    if (path === '/whatsapp/groups/update') return handleWhatsAppGroupUpdate(request);
    if (path === '/whatsapp/groups/participants') return handleWhatsAppGroupParticipants(request);
    if (path === '/whatsapp/groups/leave') return handleWhatsAppGroupLeave(request);
    if (path === '/whatsapp/groups/invite') return handleWhatsAppGroupInvite(request);
    if (path === '/whatsapp/groups/join') return handleWhatsAppGroupJoin(request);
    if (path === '/whatsapp/groups/resolve') return handleWhatsAppGroupResolve(request);
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
