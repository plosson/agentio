import type { ServiceName } from '../../types/config';
import type { InboundMessage, OutboundMessage, MediaType } from '../types';

/**
 * Result from sending a message through an adapter
 */
export interface SendResult {
  success: boolean;
  platformId?: string;
  error?: string;
}

/**
 * Inbound message data from an adapter (before DB insert)
 */
export interface AdapterInboundMessage {
  conversationId: string;
  platformId: string;
  senderId: string;
  senderName?: string;
  senderHandle?: string;
  content?: string;
  mediaType?: MediaType;
  mediaUrl?: string;        // URL for downloading media
  receivedAt: number;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Outbound message data for an adapter
 */
export interface AdapterOutboundMessage {
  conversationId: string;
  content?: string;
  mediaPath?: string;
  mediaType?: MediaType;
  replyToPlatformId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Connection state for a profile
 */
export interface ConnectionState {
  connected: boolean;
  error?: string;
  lastError?: Date;
  reconnectAttempts?: number;
}

/**
 * Service adapter interface
 * Each service implements this to handle inbound/outbound messages
 */
export interface ServiceAdapter {
  /**
   * The service this adapter handles
   */
  readonly service: ServiceName;

  /**
   * Connect to the service for a specific profile
   */
  connect(profile: string, credentials: unknown): Promise<void>;

  /**
   * Disconnect a specific profile
   */
  disconnect(profile: string): Promise<void>;

  /**
   * Disconnect all profiles
   */
  disconnectAll(): Promise<void>;

  /**
   * Check if a profile is connected
   */
  isConnected(profile: string): boolean;

  /**
   * Get connection state for a profile
   */
  getConnectionState(profile: string): ConnectionState;

  /**
   * Get all connected profiles
   */
  getConnectedProfiles(): string[];

  /**
   * Send a message through the adapter
   */
  send(profile: string, message: AdapterOutboundMessage): Promise<SendResult>;

  /**
   * Callback for when a message is received
   * Set by the gateway to handle inbound messages
   */
  onMessage: ((profile: string, message: AdapterInboundMessage) => void) | null;
}

/**
 * Base class for service adapters with common functionality
 */
export abstract class BaseAdapter implements ServiceAdapter {
  abstract readonly service: ServiceName;

  protected connections: Map<string, ConnectionState> = new Map();
  public onMessage: ((profile: string, message: AdapterInboundMessage) => void) | null = null;

  isConnected(profile: string): boolean {
    return this.connections.get(profile)?.connected ?? false;
  }

  getConnectionState(profile: string): ConnectionState {
    return this.connections.get(profile) ?? { connected: false };
  }

  getConnectedProfiles(): string[] {
    return Array.from(this.connections.entries())
      .filter(([_, state]) => state.connected)
      .map(([profile]) => profile);
  }

  protected setConnected(profile: string, connected: boolean, error?: string): void {
    const current = this.connections.get(profile) ?? { connected: false };
    this.connections.set(profile, {
      ...current,
      connected,
      error: connected ? undefined : error,
      lastError: error ? new Date() : current.lastError,
    });
  }

  protected emitMessage(profile: string, message: AdapterInboundMessage): void {
    if (this.onMessage) {
      this.onMessage(profile, message);
    }
  }

  abstract connect(profile: string, credentials: unknown): Promise<void>;
  abstract disconnect(profile: string): Promise<void>;
  abstract disconnectAll(): Promise<void>;
  abstract send(profile: string, message: AdapterOutboundMessage): Promise<SendResult>;
}
