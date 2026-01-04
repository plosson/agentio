export interface GChatSender {
  name: string;
  displayName: string;
  avatarUrl?: string;
}

export interface GChatThread {
  name: string;
}

export interface GChatMessage {
  name: string; // 'spaces/SPACE_ID/messages/MESSAGE_ID'
  displayName?: string;
  text?: string;
  createTime: string;
  updateTime: string;
  sender?: GChatSender;
  thread?: GChatThread;
}

export interface GChatDisplaySettings {
  displayName: string;
}

export interface GChatSpace {
  name: string; // 'spaces/SPACE_ID'
  displayName: string;
  type: 'ROOM' | 'DM';
  description?: string;
  displaySettings?: GChatDisplaySettings;
}

export interface GChatWebhookCredentials {
  type: 'webhook';
  webhookUrl: string;
}

export interface GChatOAuthCredentials {
  type: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
}

export type GChatCredentials = GChatWebhookCredentials | GChatOAuthCredentials;

export interface GChatSendOptions {
  threadId?: string;
  text?: string;
  payload?: Record<string, unknown>; // Raw JSON payload for rich messages (cardsV2, etc.)
}

export interface GChatListOptions {
  spaceId: string;
  limit?: number;
}

export interface GChatGetOptions {
  spaceId: string;
  messageId: string;
}

export interface GChatSendResult {
  messageId: string;
  spaceId?: string;
  text?: string;
  isJsonPayload?: boolean;
}
