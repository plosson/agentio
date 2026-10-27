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
}

/** Both ends inclusive. */
export interface SlackMessageRange {
  since: Date;
  until: Date;
}

/** The message that started an older thread; only `ts` when it could not be read. */
export interface SlackThreadParent {
  ts: string;
  user?: string;
  userName?: string;
  text?: string;
  files?: string[];
}

export interface SlackMessage {
  ts: string;
  user?: string;
  /** Bots post without a user; Slack gives their name instead. */
  botName?: string;
  /** Set when names are resolved. */
  userName?: string;
  text: string;
  /** The parent's ts, for a thread reply or a thread parent. */
  threadTs?: string;
  replyCount: number;
  files: string[];
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

export type SlackCanvasAccessLevel = 'read' | 'write' | 'owner';

export interface SlackCanvas {
  id: string;
  title: string;
  /** The creator's user id. */
  owner?: string;
  /** Set by `list`. */
  ownerName?: string;
  /** ISO 8601. */
  created?: string;
  updated?: string;
  link?: string;
  /** Set for a channel's canvas. */
  channelId?: string;
}

export interface SlackCanvasContent extends SlackCanvas {
  markdown: string;
  unconverted: string[];
}

export interface SlackCanvasList {
  canvases: SlackCanvas[];
  /** files.list stopped at its page limit, so older canvases may be missing. */
  truncated: boolean;
}

/** Who a canvas is shared with or unshared from, already resolved to ids. */
export interface SlackCanvasTargets {
  users: string[];
  channels: string[];
}
