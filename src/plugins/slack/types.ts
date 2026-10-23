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
