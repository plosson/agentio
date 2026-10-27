export interface SlackWebhookCredentials {
  type: 'webhook';
  webhookUrl: string;
  channelName?: string;
}

/** A user token (xoxp-) from the user's own Slack app, for the Web API. */
export interface SlackTokenCredentials {
  type: 'token';
  token: string;
  teamId?: string;
  teamName?: string;
  /** Who the token acts as. */
  userName?: string;
}

export type SlackCredentials = SlackWebhookCredentials | SlackTokenCredentials;

export interface SlackSendOptions {
  text?: string;
  payload?: Record<string, unknown>;
}

export interface SlackSendResult {
  success: boolean;
  isJsonPayload?: boolean;
}

/** What `auth.test` says about a token. */
export interface SlackAuthInfo {
  teamId: string;
  teamName: string;
  userId: string;
  userName: string;
  url?: string;
}

export interface SlackUser {
  id: string;
  name: string;
  realName?: string;
  displayName?: string;
  email?: string;
  title?: string;
  isAdmin: boolean;
  isOwner: boolean;
  isBot: boolean;
  deleted: boolean;
  /** Guest accounts: single- or multi-channel. */
  isRestricted: boolean;
}

export interface SlackUserListOptions {
  includeDeleted?: boolean;
  includeBots?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  /** Whether the token's user is a member. */
  isMember: boolean;
  topic?: string;
  purpose?: string;
  numMembers?: number;
  /** ISO 8601. */
  created?: string;
}

export interface SlackChannelListOptions {
  privateOnly?: boolean;
  includeArchived?: boolean;
}

export interface SlackChannelCreateOptions {
  isPrivate?: boolean;
  topic?: string;
  purpose?: string;
}

export interface SlackChannelUpdate {
  name?: string;
  topic?: string;
  purpose?: string;
}

/** What `archive`, `unarchive` and `leave` did; `changed` is false when there was nothing to do. */
export interface SlackChannelChange {
  channel: SlackChannel;
  changed: boolean;
}

/** What `invite` and `remove` did, user by user. */
export interface SlackMembershipResult {
  channel: SlackChannel;
  changed: SlackUser[];
  /** Already members (invite) or not members (remove), so left alone. */
  skipped: SlackUser[];
}

export type SlackConversationType = 'channel' | 'private' | 'dm' | 'group';

export interface SlackConversation {
  id: string;
  /** Channel name; for a direct message, the other person's name once names are resolved. */
  name: string;
  type: SlackConversationType;
  /** Direct messages: the other person's user id. */
  user?: string;
  /** False for a public channel read without being in it (`--include-public`). */
  isMember: boolean;
}

/** Both ends inclusive. */
export interface SlackMessageRange {
  since: Date;
  until: Date;
}

/** A file shared in a message. Only `id` and `name` are always there: Slack leaves the rest out for deleted or hidden files. */
export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  /** Bytes. */
  size?: number;
  /** Needs the token in an Authorization header; see `agentio slack download`. */
  urlPrivateDownload?: string;
  permalink?: string;
  /** Slack's mode when it is not a normal upload: external, snippet, post, tombstone (deleted), hidden_by_limit. */
  mode?: string;
}

/** What names are resolved from: one workspace member. */
export interface SlackDirectoryEntry {
  id: string;
  /** The handle. */
  name: string;
  realName?: string;
  displayName?: string;
}

/** The message that started an older thread; only `ts` (and `permalink`) when it could not be read. */
export interface SlackThreadParent {
  ts: string;
  user?: string;
  userName?: string;
  realName?: string;
  displayName?: string;
  text?: string;
  files?: SlackFile[];
  permalink?: string;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  /** Bots post without a user; Slack gives their name instead. */
  botName?: string;
  /** Set when names are resolved: the display name, else the real name, else the handle. */
  userName?: string;
  /** The author's full name and display name, when the workspace has them. */
  realName?: string;
  displayName?: string;
  text: string;
  /** The parent's ts, for a thread reply or a thread parent. */
  threadTs?: string;
  replyCount: number;
  files: SlackFile[];
  /** A link to the message in Slack; a thread reply's opens its thread. */
  permalink?: string;
  replies: SlackMessage[];
  source: 'history' | 'search';
  /** Only on a reply in a thread that started before the range. */
  parent?: SlackThreadParent;
}

export interface SlackConversationMessages extends SlackConversation {
  messages: SlackMessage[];
}

export interface SlackMessagesResult {
  /** ISO 8601. */
  since: string;
  until: string;
  conversations: SlackConversationMessages[];
}

export interface SlackSearchMatch {
  channelId: string;
  message: SlackMessage;
}

export interface SlackSearchResult {
  matches: SlackSearchMatch[];
  /** Not every match was read: past Slack's 100 pages, or rate-limited partway. */
  truncated: boolean;
}

/** One file in an `agentio slack attachments` run. */
export interface SlackManifestEntry {
  conversationId: string;
  conversation: string;
  messageTs: string;
  /** ISO 8601. */
  time: string;
  user?: string;
  userName?: string;
  realName?: string;
  permalink?: string;
  fileId: string;
  name: string;
  mimetype?: string;
  size?: number;
  /** Path the file was (or, in a dry run, would be) saved to. */
  savedPath: string;
  status: 'saved' | 'failed' | 'skipped' | 'planned';
  bytes?: number;
  /** Why the file failed or was skipped. */
  error?: string;
}

export interface SlackAttachmentsResult {
  outDir: string;
  messagesScanned: number;
  messagesWithFiles: number;
  files: number;
  saved: number;
  failed: number;
  skipped: number;
  manifestJson: string;
  manifestCsv: string;
  entries: SlackManifestEntry[];
}
