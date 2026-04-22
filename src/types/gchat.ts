export interface GChatSender {
  name: string;
  displayName: string;
  email?: string;
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

export interface GChatUser {
  name: string; // 'users/USER_ID'
  displayName?: string;
  email?: string;
  phoneNumbers?: string[];
  organizations?: Array<{ name?: string; title?: string; department?: string }>;
  photoUrl?: string;
  locations?: string[];
}

export interface GChatMember {
  name: string; // 'spaces/SPACE_ID/members/MEMBER_ID'
  role: 'ROLE_MEMBER' | 'ROLE_MANAGER' | 'ROLE_UNSPECIFIED';
  state: 'JOINED' | 'INVITED' | 'NOT_A_MEMBER' | 'MEMBERSHIP_STATE_UNSPECIFIED';
  memberType: 'HUMAN' | 'BOT';
  user?: GChatUser;
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
  email: string;
}

export type GChatCredentials = GChatWebhookCredentials | GChatOAuthCredentials;

export interface GChatSendOptions {
  threadId?: string;
  text?: string;
  payload?: Record<string, unknown>; // Raw JSON payload for rich messages (cardsV2, etc.)
  attachments?: string[]; // Local file paths to upload and attach (OAuth only)
}

export interface GChatListOptions {
  spaceId: string;
  limit?: number;
  threadId?: string;
  since?: Date;
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
