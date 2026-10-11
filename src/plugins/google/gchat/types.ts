export interface GChatSender {
  name: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
}

export interface GChatThread {
  name: string;
}

/**
 * A file attached to a message. Uploaded files carry `attachmentDataRef`
 * (downloadable through the Chat media API); Drive files carry `driveDataRef`.
 */
export interface GChatAttachment {
  name: string; // 'spaces/SPACE_ID/messages/MESSAGE_ID/attachments/ATTACHMENT_ID'
  contentName?: string;
  contentType?: string;
  /** 'UPLOADED_CONTENT' or 'DRIVE_FILE' */
  source?: string;
  attachmentDataRef?: { resourceName?: string };
  driveDataRef?: { driveFileId?: string };
  thumbnailUri?: string;
  downloadUri?: string;
}

export interface GChatMessage {
  name: string; // 'spaces/SPACE_ID/messages/MESSAGE_ID'
  displayName?: string;
  text?: string;
  createTime: string;
  updateTime: string;
  sender?: GChatSender;
  thread?: GChatThread;
  attachment?: GChatAttachment[];
  /** Raw Chat API cardsV2, passed through untouched. */
  cardsV2?: unknown[];
  /** Raw Chat API annotations (mentions, slash commands, rich links), passed through untouched. */
  annotations?: unknown[];
  /** Raw Chat API attachedGifs, passed through untouched. */
  attachedGifs?: unknown[];
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
  until?: Date;
}

export interface GChatListResult {
  messages: GChatMessage[];
  /** True when --limit was reached while more messages still exist in range. */
  truncated: boolean;
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

export interface GChatAttachmentsOptions {
  spaceId: string;
  since?: Date;
  until?: Date;
  outDir: string;
  /** List what would be saved and write the manifest, without downloading. */
  dryRun?: boolean;
  /** Called once per attachment as it finishes (progress on stderr). */
  onProgress?: (entry: GChatManifestEntry, index: number) => void;
}

export interface GChatManifestEntry {
  messageName: string;
  createTime: string;
  sender: string;
  senderEmail?: string;
  attachmentName: string;
  contentName: string;
  contentType: string;
  source: string;
  /** Path the file was (or, in a dry run, would be) saved to. */
  savedPath: string;
  status: 'saved' | 'failed' | 'planned';
  bytes?: number;
  error?: string;
}

export interface GChatAttachmentsResult {
  outDir: string;
  messagesScanned: number;
  messagesWithAttachments: number;
  attachments: number;
  saved: number;
  failed: number;
  manifestJson: string;
  manifestCsv: string;
  entries: GChatManifestEntry[];
}
