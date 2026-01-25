import type { ServiceName, GatewayConfig } from '../types/config';

// Re-export for convenience
export type { GatewayConfig } from '../types/config';

/**
 * Inbound message - received from external services
 */
export interface InboundMessage {
  id: string;                    // UUID
  service: ServiceName;
  profile: string;
  conversationId: string;        // Chat/thread identifier
  platformId: string;            // Original message ID from platform

  senderId: string;
  senderName?: string;
  senderHandle?: string;

  content?: string;              // Message text
  mediaType?: MediaType;
  mediaPath?: string;            // Local path if downloaded

  receivedAt: number;            // Unix timestamp
  status: InboxStatus;
  doneAt?: number;

  replyToId?: string;            // If this is a reply
  metadata?: Record<string, unknown>;
}

/**
 * Outbound message - queued for sending to services
 */
export interface OutboundMessage {
  id: string;                    // UUID
  service: ServiceName;
  profile: string;
  conversationId: string;        // Destination chat/thread

  content?: string;
  mediaPath?: string;
  mediaType?: MediaType;

  replyToPlatformId?: string;    // If replying to a message

  queuedAt: number;              // Unix timestamp
  status: OutboxStatus;
  sentAt?: number;
  error?: string;
  platformId?: string;           // Assigned after send

  metadata?: Record<string, unknown>;
}

export type MediaType = 'image' | 'video' | 'audio' | 'document';
export type InboxStatus = 'pending' | 'done';
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

export const DEFAULT_GATEWAY_CONFIG: Required<GatewayConfig> = {
  api: {
    port: 7890,
    host: '127.0.0.1',
    secret: '',
  },
  webhook: {
    url: '',
    secret: '',
    debounceMs: 2000,
  },
  media: {
    download: true,
    maxSizeMb: 50,
  },
  retention: {
    doneMessagesDays: 30,
    sentMessagesDays: 7,
  },
};

/**
 * Gateway HTTP API request/response types
 */
export interface InboxPullRequest {
  service?: ServiceName;
  profile?: string;
  limit?: number;
  status?: InboxStatus;
}

export interface InboxPullResponse {
  messages: InboundMessage[];
}

export interface InboxGetRequest {
  id: string;
}

export interface InboxGetResponse {
  message: InboundMessage | null;
}

export interface InboxAckRequest {
  id: string;
}

export interface InboxAckResponse {
  success: boolean;
}

export interface InboxReplyRequest {
  id: string;
  content: string;
  mediaPath?: string;
  mediaType?: MediaType;
}

export interface InboxReplyResponse {
  outboxId: string;
  status: OutboxStatus;
}

export interface InboxStatsRequest {
  service?: ServiceName;
  profile?: string;
}

export interface InboxStatsResponse {
  pending: number;
  done: number;
  total: number;
}

export interface OutboxSendRequest {
  service: ServiceName;
  profile: string;
  conversationId: string;
  content?: string;
  mediaPath?: string;
  mediaType?: MediaType;
  replyToPlatformId?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboxSendResponse {
  id: string;
  status: OutboxStatus;
}

export interface OutboxStatusRequest {
  id: string;
}

export interface OutboxStatusResponse {
  message: OutboundMessage | null;
}

export interface OutboxListRequest {
  service?: ServiceName;
  profile?: string;
  status?: OutboxStatus;
  limit?: number;
}

export interface OutboxListResponse {
  messages: OutboundMessage[];
}

export interface GatewayStatusResponse {
  running: boolean;
  uptime: number;
  adapters: {
    service: ServiceName;
    profile: string;
    connected: boolean;
    error?: string;
  }[];
}

export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: number;
}

/**
 * Webhook notification payload
 */
export interface WebhookPayload {
  event: 'inbox.message';
  timestamp: number;
  messages: {
    id: string;
    service: ServiceName;
    profile: string;
    sender: string;
    preview: string;
  }[];
}

/**
 * Daemon state
 */
export interface DaemonState {
  pid: number;
  startedAt: number;
  adapters: string[];  // Format: "service:profile"
}

/**
 * WhatsApp pairing request/response types
 */
export interface WhatsAppPairRequest {
  profile: string;
}

export interface WhatsAppPairResponse {
  status: 'waiting_qr' | 'connected' | 'connecting' | 'not_configured';
  qrCode?: string;         // QR code string for Baileys
  phoneNumber?: string;    // Phone number if connected
  displayName?: string;    // Display name if available
  message?: string;        // Status message
}
