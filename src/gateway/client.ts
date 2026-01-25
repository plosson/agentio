import { CliError } from '../utils/errors';
import { loadConfig } from '../config/config-manager';
import { getEnv } from '../config/config-manager';
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
  InboundMessage,
  OutboundMessage,
  MediaType,
  InboxStatus,
  OutboxStatus,
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
import type { WhatsAppGroup, WhatsAppParticipantAction } from '../types/whatsapp';

let cachedConfig: { url: string; secret: string } | null = null;

/**
 * Get gateway URL and secret from config or environment
 */
async function getGatewayConnection(): Promise<{ url: string; secret: string }> {
  if (cachedConfig) return cachedConfig;

  // Check environment variables first
  const envUrl = process.env.AGENTIO_GATEWAY_URL || await getEnv('AGENTIO_GATEWAY_URL');
  const envSecret = process.env.AGENTIO_GATEWAY_SECRET || await getEnv('AGENTIO_GATEWAY_SECRET');

  if (envUrl) {
    cachedConfig = { url: envUrl, secret: envSecret || '' };
    return cachedConfig;
  }

  // Load from config
  const config = await loadConfig() as unknown as { gateway?: GatewayConfig };
  const gatewayConfig = config.gateway;

  if (!gatewayConfig?.api) {
    throw new CliError('CONFIG_ERROR', 'Gateway not configured', 'Set AGENTIO_GATEWAY_URL or configure gateway in config');
  }

  const host = gatewayConfig.api.host ?? '127.0.0.1';
  const port = gatewayConfig.api.port ?? 7890;
  const url = `http://${host}:${port}`;
  const secret = gatewayConfig.api.secret ?? '';

  cachedConfig = { url, secret };
  return cachedConfig;
}

/**
 * Make a request to the gateway API
 */
async function request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const { url, secret } = await getGatewayConnection();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  try {
    const response = await fetch(`${url}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new CliError('AUTH_FAILED', 'Gateway authentication failed', 'Check AGENTIO_GATEWAY_SECRET');
      }

      const errorData = await response.json().catch(() => ({})) as { error?: string };
      throw new CliError('API_ERROR', errorData.error || `Gateway error: ${response.status}`);
    }

    return await response.json() as T;
  } catch (error) {
    if (error instanceof CliError) throw error;

    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new CliError('NETWORK_ERROR', 'Cannot connect to gateway', 'Is the gateway running? Try: agentio gateway status');
    }

    throw new CliError('NETWORK_ERROR', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Gateway client for CLI commands
 */
export class GatewayClient {
  /**
   * Check gateway health
   */
  async health(): Promise<HealthResponse> {
    return request<HealthResponse>('GET', '/health');
  }

  /**
   * Get gateway status
   */
  async status(): Promise<GatewayStatusResponse> {
    return request<GatewayStatusResponse>('GET', '/status');
  }

  /**
   * Pull messages from inbox
   */
  async inboxPull(options: {
    service?: ServiceName;
    profile?: string;
    conversationId?: string;
    limit?: number;
    status?: InboxStatus;
  }): Promise<InboundMessage[]> {
    const body: InboxPullRequest = {
      service: options.service,
      profile: options.profile,
      conversationId: options.conversationId,
      limit: options.limit,
      status: options.status,
    };
    const response = await request<InboxPullResponse>('POST', '/inbox/pull', body);
    return response.messages;
  }

  /**
   * Get a specific inbox message
   */
  async inboxGet(id: string): Promise<InboundMessage | null> {
    const body: InboxGetRequest = { id };
    const response = await request<InboxGetResponse>('POST', '/inbox/get', body);
    return response.message;
  }

  /**
   * Acknowledge (mark as done) an inbox message
   */
  async inboxAck(id: string): Promise<boolean> {
    const body: InboxAckRequest = { id };
    const response = await request<InboxAckResponse>('POST', '/inbox/ack', body);
    return response.success;
  }

  /**
   * Reply to an inbox message
   */
  async inboxReply(id: string, content: string, options?: {
    mediaPath?: string;
    mediaType?: MediaType;
  }): Promise<{ outboxId: string; status: OutboxStatus }> {
    const body: InboxReplyRequest = {
      id,
      content,
      mediaPath: options?.mediaPath,
      mediaType: options?.mediaType,
    };
    const response = await request<InboxReplyResponse>('POST', '/inbox/reply', body);
    return { outboxId: response.outboxId, status: response.status };
  }

  /**
   * Get inbox statistics
   */
  async inboxStats(options?: {
    service?: ServiceName;
    profile?: string;
  }): Promise<{ pending: number; done: number; total: number }> {
    const body: InboxStatsRequest = {
      service: options?.service,
      profile: options?.profile,
    };
    return request<InboxStatsResponse>('POST', '/inbox/stats', body);
  }

  /**
   * Send a message via outbox
   */
  async outboxSend(options: {
    service: ServiceName;
    profile: string;
    conversationId: string;
    content?: string;
    mediaPath?: string;
    mediaType?: MediaType;
    replyToPlatformId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; status: OutboxStatus }> {
    const body: OutboxSendRequest = {
      service: options.service,
      profile: options.profile,
      conversationId: options.conversationId,
      content: options.content,
      mediaPath: options.mediaPath,
      mediaType: options.mediaType,
      replyToPlatformId: options.replyToPlatformId,
      metadata: options.metadata,
    };
    const response = await request<OutboxSendResponse>('POST', '/outbox/send', body);
    return { id: response.id, status: response.status };
  }

  /**
   * Get outbox message status
   */
  async outboxStatus(id: string): Promise<OutboundMessage | null> {
    const body: OutboxStatusRequest = { id };
    const response = await request<OutboxStatusResponse>('POST', '/outbox/status', body);
    return response.message;
  }

  /**
   * List outbox messages
   */
  async outboxList(options?: {
    service?: ServiceName;
    profile?: string;
    status?: OutboxStatus;
    limit?: number;
  }): Promise<OutboundMessage[]> {
    const body: OutboxListRequest = {
      service: options?.service,
      profile: options?.profile,
      status: options?.status,
      limit: options?.limit,
    };
    const response = await request<OutboxListResponse>('POST', '/outbox/list', body);
    return response.messages;
  }

  /**
   * Get media URL for an inbox message
   */
  getMediaUrl(messageId: string): string {
    // This needs the URL synchronously, so we use cached config
    if (!cachedConfig) {
      throw new CliError('CONFIG_ERROR', 'Gateway not configured');
    }
    return `${cachedConfig.url}/media/${messageId}`;
  }

  /**
   * Get WhatsApp pairing status and QR code
   */
  async whatsappPair(profile: string): Promise<WhatsAppPairResponse> {
    return request<WhatsAppPairResponse>('GET', `/whatsapp/pair/${encodeURIComponent(profile)}`);
  }

  // ============ WHATSAPP GROUP METHODS ============

  /**
   * List all WhatsApp groups
   */
  async whatsappGroupList(profile: string): Promise<WhatsAppGroup[]> {
    const body: WhatsAppGroupListRequest = { profile };
    const response = await request<WhatsAppGroupListResponse>('POST', '/whatsapp/groups/list', body);
    return response.groups;
  }

  /**
   * Get WhatsApp group details
   */
  async whatsappGroupGet(profile: string, groupId: string): Promise<WhatsAppGroup> {
    const body: WhatsAppGroupGetRequest = { profile, groupId };
    const response = await request<WhatsAppGroupGetResponse>('POST', '/whatsapp/groups/get', body);
    return response.group;
  }

  /**
   * Create a WhatsApp group
   */
  async whatsappGroupCreate(profile: string, name: string, participants: string[]): Promise<WhatsAppGroup> {
    const body: WhatsAppGroupCreateRequest = { profile, name, participants };
    const response = await request<WhatsAppGroupCreateResponse>('POST', '/whatsapp/groups/create', body);
    return response.group;
  }

  /**
   * Update WhatsApp group info
   */
  async whatsappGroupUpdate(
    profile: string,
    groupId: string,
    options: { subject?: string; description?: string }
  ): Promise<boolean> {
    const body: WhatsAppGroupUpdateRequest = { profile, groupId, ...options };
    const response = await request<WhatsAppGroupUpdateResponse>('POST', '/whatsapp/groups/update', body);
    return response.success;
  }

  /**
   * Update WhatsApp group participants
   */
  async whatsappGroupParticipants(
    profile: string,
    groupId: string,
    participants: string[],
    action: WhatsAppParticipantAction
  ): Promise<{ success: boolean; results?: { participant: string; status: string }[] }> {
    const body: WhatsAppGroupParticipantsRequest = { profile, groupId, participants, action };
    const response = await request<WhatsAppGroupParticipantsResponse>('POST', '/whatsapp/groups/participants', body);
    return response;
  }

  /**
   * Leave a WhatsApp group
   */
  async whatsappGroupLeave(profile: string, groupId: string): Promise<boolean> {
    const body: WhatsAppGroupLeaveRequest = { profile, groupId };
    const response = await request<WhatsAppGroupLeaveResponse>('POST', '/whatsapp/groups/leave', body);
    return response.success;
  }

  /**
   * Get WhatsApp group invite link
   */
  async whatsappGroupInvite(profile: string, groupId: string): Promise<{ inviteCode: string; inviteLink: string }> {
    const body: WhatsAppGroupInviteRequest = { profile, groupId };
    const response = await request<WhatsAppGroupInviteResponse>('POST', '/whatsapp/groups/invite', body);
    return response;
  }

  /**
   * Join WhatsApp group via invite code
   */
  async whatsappGroupJoin(profile: string, inviteCode: string): Promise<string> {
    const body: WhatsAppGroupJoinRequest = { profile, inviteCode };
    const response = await request<WhatsAppGroupJoinResponse>('POST', '/whatsapp/groups/join', body);
    return response.groupId;
  }

  /**
   * Resolve group name to JID or vice versa
   */
  async whatsappGroupResolve(profile: string, nameOrId: string): Promise<{ groupId: string | null; groupName: string | null }> {
    const body: WhatsAppGroupResolveRequest = { profile, nameOrId };
    const response = await request<WhatsAppGroupResolveResponse>('POST', '/whatsapp/groups/resolve', body);
    return response;
  }
}

/**
 * Get a gateway client instance
 */
export async function getGatewayClient(): Promise<GatewayClient> {
  // Ensure config is loaded
  await getGatewayConnection();
  return new GatewayClient();
}

/**
 * Check if gateway is available
 */
export async function isGatewayAvailable(): Promise<boolean> {
  try {
    const client = await getGatewayClient();
    await client.health();
    return true;
  } catch {
    return false;
  }
}
