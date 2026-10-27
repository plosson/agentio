import type { ServiceClient, ValidationResult } from '../../types/service';
import { chunk } from '../../utils/batch';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type {
  SlackChannelChange,
  SlackAuthInfo,
  SlackCanvas,
  SlackCanvasAccessLevel,
  SlackCanvasList,
  SlackCanvasTargets,
  SlackChannel,
  SlackChannelCreateOptions,
  SlackChannelListOptions,
  SlackChannelUpdate,
  SlackConversation,
  SlackConversationType,
  SlackCredentials,
  SlackMembershipResult,
  SlackMessage,
  SlackMessageRange,
  SlackSearchMatch,
  SlackSearchResult,
  SlackSendOptions,
  SlackSendResult,
  SlackTokenCredentials,
  SlackUser,
  SlackUserListOptions,
  SlackWebhookCredentials,
} from './types';

export const SLACK_API_URL = 'https://slack.com/api';
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 200;
/** Retries after a 429; Slack's Retry-After is honoured up to MAX_RETRY_WAIT_S each time. */
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_S = 60;
/** From this many users, invite and uninvite read users.list once instead of looking each one up. */
const BULK_LOOKUP_MIN = 3;

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  response_metadata?: { next_cursor?: string };
}

interface RawUser {
  id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_bot?: boolean;
  is_restricted?: boolean;
  profile?: { real_name?: string; display_name?: string; email?: string; title?: string };
}

interface RawChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  created?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface RawMessage {
  ts: string;
  user?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: { name?: string; title?: string }[];
}

interface RawConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
}

interface RawSearchMatch extends Partial<RawMessage> {
  channel?: { id?: string };
  permalink?: unknown;
}

interface RawChannelProperties {
  canvas?: { file_id?: string };
  tabs?: { type?: string; data?: { file_id?: string } }[];
}

interface RawFile {
  id: string;
  title?: string;
  name?: string;
  filetype?: string;
  user?: string;
  created?: number;
  updated?: number;
  permalink?: string;
  url_private_download?: string;
  linked_channel_id?: string | null;
}

/** Canvases are files of this type. */
const CANVAS_FILETYPE = 'quip';
/** files.list: at most 100 files per page; pages are read up to this many. */
const FILES_PAGE_SIZE = 100;
const FILES_MAX_PAGES = 100;
/** canvases.access.set and .delete take at most this many ids per call. */
const ACCESS_BATCH = 20;

/** Slack's conversation type for each of ours. */
const CONVERSATION_TYPES: Record<SlackConversationType, string> = {
  channel: 'public_channel', private: 'private_channel', dm: 'im', group: 'mpim',
};
/** search.messages answers at most 100 per page and 100 pages. */
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 100;
const DAY_MS = 86_400_000;

/** The token-only Web API errors that have a clearer meaning than Slack's code. */
const API_ERRORS: Record<string, { code: ErrorCode; message: string; suggestion?: string }> = {
  not_authed: { code: 'AUTH_FAILED', message: 'Slack received no token' },
  invalid_auth: { code: 'AUTH_FAILED', message: 'Slack refused the token', suggestion: 'Check the token, then run: agentio slack profile add' },
  token_revoked: { code: 'AUTH_FAILED', message: 'The Slack token was revoked', suggestion: 'Reinstall the Slack app, then run: agentio slack profile add' },
  token_expired: { code: 'AUTH_EXPIRED', message: 'The Slack token expired', suggestion: 'Turn off token rotation in the Slack app, reinstall it, then run: agentio slack profile add' },
  account_inactive: { code: 'AUTH_FAILED', message: 'The Slack account behind the token is deactivated' },
  not_allowed_token_type: { code: 'AUTH_FAILED', message: 'Slack does not accept this kind of token here', suggestion: 'Use the User OAuth Token (xoxp-), not the bot token' },
  users_not_found: { code: 'NOT_FOUND', message: 'No Slack user has this email address' },
  user_not_found: { code: 'NOT_FOUND', message: 'No Slack user has this id' },
  ratelimited: { code: 'RATE_LIMITED', message: 'Slack rate limit reached', suggestion: 'Wait a minute and try again' },
  channel_not_found: { code: 'NOT_FOUND', message: 'No channel with this id is visible to you', suggestion: 'Private channels are visible only to their members' },
  name_taken: { code: 'INVALID_PARAMS', message: 'A channel with this name already exists, perhaps archived or private' },
  restricted_action: { code: 'PERMISSION_DENIED', message: 'A workspace setting does not let you do this' },
  is_archived: { code: 'INVALID_PARAMS', message: 'The channel is archived' },
  not_in_channel: { code: 'PERMISSION_DENIED', message: 'You must be a member of the channel to do this' },
  cant_invite_self: { code: 'INVALID_PARAMS', message: 'You cannot invite yourself' },
  cant_kick_self: { code: 'INVALID_PARAMS', message: 'You cannot uninvite yourself; leave the channel in Slack instead' },
  cant_archive_general: { code: 'INVALID_PARAMS', message: 'The workspace\'s general channel cannot be archived' },
  cant_leave_general: { code: 'INVALID_PARAMS', message: 'Nobody can leave the workspace\'s general channel' },
  last_member: { code: 'INVALID_PARAMS', message: 'You are the last member of this private channel, so you cannot leave it' },
  cant_kick_from_general: { code: 'INVALID_PARAMS', message: 'Nobody can be removed from the workspace\'s general channel' },
  ura_max_channels: { code: 'INVALID_PARAMS', message: 'A single-channel guest cannot join a second channel' },
  user_is_restricted: { code: 'PERMISSION_DENIED', message: 'A guest cannot be invited here' },
  user_is_ultra_restricted: { code: 'INVALID_PARAMS', message: 'A single-channel guest cannot join a second channel' },
  thread_not_found: { code: 'NOT_FOUND', message: 'The thread is gone, perhaps deleted' },
  file_not_found: { code: 'NOT_FOUND', message: 'No canvas or file with this id is visible to you' },
  file_deleted: { code: 'NOT_FOUND', message: 'The canvas was deleted' },
  canvas_not_found: { code: 'NOT_FOUND', message: 'No canvas with this id is visible to you' },
  canvas_deleted: { code: 'NOT_FOUND', message: 'The canvas was deleted' },
  canvas_creation_failed: { code: 'API_ERROR', message: 'Slack could not create a canvas from this Markdown', suggestion: 'Check the Markdown: headings, lists, links and mentions such as ![](@U123) are supported' },
  canvas_editing_failed: { code: 'API_ERROR', message: 'Slack could not apply this Markdown to the canvas', suggestion: 'Check the Markdown: headings, lists, links and mentions such as ![](@U123) are supported' },
  channel_canvas_already_exists: { code: 'INVALID_PARAMS', message: 'This channel already has a canvas', suggestion: 'Replace its content with: agentio slack canvases set #<channel>' },
  canvas_disabled_user_team: { code: 'PERMISSION_DENIED', message: 'Canvases are turned off in this workspace' },
  team_tier_cannot_create_channel_canvases: { code: 'PERMISSION_DENIED', message: 'This workspace\'s plan does not allow channel canvases' },
};

export function isTokenCredentials(credentials: SlackCredentials): credentials is SlackTokenCredentials {
  return credentials.type === 'token';
}

/** A user token as pasted: trimmed, and refused when it is not a user token. */
export function checkUserToken(input: string): string {
  const token = input.trim();
  if (token.startsWith('xoxb-')) {
    throw new CliError('INVALID_PARAMS', 'This is a bot token (xoxb-)',
      'Admin commands act as you: copy the User OAuth Token (xoxp-) from OAuth & Permissions');
  }
  if (!/^xoxp-[A-Za-z0-9-]+$/.test(token)) {
    throw new CliError('INVALID_PARAMS', 'A Slack user token starts with xoxp-',
      'Copy the User OAuth Token from your Slack app, under OAuth & Permissions');
  }
  return token;
}

/** Whether `input` names a channel by id (C…, G…) rather than by name. */
export function isChannelId(input: string): boolean {
  return /^[CG][A-Z0-9]{2,}$/.test(input);
}

/**
 * A channel name as Slack allows it: at most 80 lowercase letters, digits,
 * hyphens and underscores. A leading # is dropped; anything else is refused
 * rather than silently changed.
 */
export function checkChannelName(input: string): string {
  const name = input.trim().replace(/^#/, '');
  if (!name) throw new CliError('INVALID_PARAMS', 'A channel name is required');
  if (name.length > 80) throw new CliError('INVALID_PARAMS', `A channel name has at most 80 characters, not ${name.length}`);
  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new CliError('INVALID_PARAMS', `"${name}" is not a valid channel name`,
      'Use only lowercase letters, digits, hyphens and underscores, such as team-design');
  }
  return name;
}

/** Topic and purpose: Slack's limit is 250 characters. */
function checkChannelText(label: string, value: string): string {
  if (value.length > 250) throw new CliError('INVALID_PARAMS', `The ${label} has at most 250 characters, not ${value.length}`);
  return value;
}

function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(input);
}

/** Whether `input` names a user by id (U… or W…) rather than by email. */
export function isUserId(input: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/.test(input);
}

/** A Web API error, keeping Slack's own code for callers that expect some of them. */
export class SlackApiError extends CliError {
  constructor(public slackError: string, code: ErrorCode, message: string, suggestion?: string) {
    super(code, message, suggestion);
  }
}

/** A date as a Slack timestamp: seconds, six decimals. */
export function slackTs(date: Date): string {
  return (date.getTime() / 1000).toFixed(6);
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The search query for a range. Search dates are whole days in the user's time
 * zone, and exclusive, so the range is widened by two days each side and the
 * results are trimmed after.
 */
export function searchQuery(range: SlackMessageRange): string {
  return `after:${isoDay(range.since.getTime() - 2 * DAY_MS)} before:${isoDay(range.until.getTime() + 2 * DAY_MS)}`;
}

/** The thread a search result belongs to, read from its permalink; undefined when there is none or it is malformed. */
export function threadTsFromPermalink(permalink: unknown): string | undefined {
  if (typeof permalink !== 'string') return undefined;
  try {
    const ts = new URL(permalink).searchParams.get('thread_ts');
    return ts && /^\d+\.\d+$/.test(ts) ? ts : undefined;
  } catch {
    return undefined;
  }
}

function toCanvas(raw: RawFile): SlackCanvas {
  const iso = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);
  return {
    id: raw.id,
    title: raw.title ?? raw.name ?? '',
    owner: raw.user || undefined,
    created: iso(raw.created),
    updated: iso(raw.updated),
    link: raw.permalink || undefined,
    channelId: raw.linked_channel_id || undefined,
  };
}

/** The canvas download link, refused unless it is https://files.slack.com, so the token goes nowhere else. */
export function checkDownloadUrl(url: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new CliError('API_ERROR', 'Slack gave no download link for this canvas');
  }
  if (typeof url !== 'string' || parsed.protocol !== 'https:' || parsed.hostname !== 'files.slack.com'
    || parsed.username || parsed.password || parsed.port) {
    throw new CliError('API_ERROR', `Refusing to send the Slack token to ${parsed.protocol}//${parsed.host}`,
      'Canvas downloads come only from https://files.slack.com');
  }
  return parsed.toString();
}

/** The name to show for a user: display name, else real name, else handle. */
export function displayNameOf(user: SlackUser): string {
  return user.displayName || user.realName || user.name;
}

/** Markdown as canvases.create and canvases.edit take it. */
const markdownContent = (markdown: string) => ({ type: 'markdown', markdown });

/** Slack timestamps have more digits than a Number holds, so they compare as strings. */
export function compareTs(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toMessage(raw: Partial<RawMessage> & { ts: string }, source: SlackMessage['source']): SlackMessage {
  return {
    ts: raw.ts,
    user: raw.user || undefined,
    botName: raw.username || raw.bot_profile?.name || undefined,
    text: raw.text ?? '',
    threadTs: raw.thread_ts || undefined,
    replyCount: raw.reply_count ?? 0,
    files: (raw.files ?? []).map((f) => f.name || f.title || 'file'),
    replies: [],
    source,
  };
}

function toConversation(raw: RawConversation): SlackConversation {
  const type: SlackConversationType = raw.is_im ? 'dm' : raw.is_mpim ? 'group' : raw.is_private ? 'private' : 'channel';
  return { id: raw.id, name: raw.name || raw.user || raw.id, type, ...(raw.user ? { user: raw.user } : {}) };
}

function toChannel(raw: RawChannel): SlackChannel {
  return {
    id: raw.id,
    name: raw.name,
    isPrivate: !!raw.is_private,
    isArchived: !!raw.is_archived,
    isMember: !!raw.is_member,
    topic: raw.topic?.value || undefined,
    purpose: raw.purpose?.value || undefined,
    numMembers: raw.num_members,
    created: raw.created ? new Date(raw.created * 1000).toISOString() : undefined,
  };
}

function toUser(raw: RawUser): SlackUser {
  const profile = raw.profile ?? {};
  return {
    id: raw.id,
    name: raw.name,
    realName: profile.real_name || raw.real_name || undefined,
    displayName: profile.display_name || undefined,
    email: profile.email || undefined,
    title: profile.title || undefined,
    isAdmin: !!raw.is_admin,
    isOwner: !!raw.is_owner,
    isBot: !!raw.is_bot || raw.id === 'USLACKBOT',
    deleted: !!raw.deleted,
    isRestricted: !!raw.is_restricted,
  };
}

export class SlackClient implements ServiceClient {
  private credentials: SlackCredentials;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(credentials: SlackCredentials, options: { sleep?: (ms: number) => Promise<void> } = {}) {
    this.credentials = credentials;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async validate(): Promise<ValidationResult> {
    if (isTokenCredentials(this.credentials)) {
      try {
        const auth = await this.authTest();
        return { valid: true, info: `${auth.userName} @ ${auth.teamName}` };
      } catch (error) {
        return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }
    const webhookCreds = this.credentials as SlackWebhookCredentials;
    const info = webhookCreds.channelName ? `#${webhookCreds.channelName}` : 'webhook';
    return { valid: true, info };
  }

  async send(options: SlackSendOptions): Promise<SlackSendResult> {
    if (this.credentials.type === 'webhook') {
      return this.sendViaWebhook(options);
    }
    throw new CliError('INVALID_PARAMS', 'This Slack profile holds a user token, which cannot send messages yet',
      'Send with a webhook profile: agentio slack send --profile <webhook profile>');
  }

  async authTest(): Promise<SlackAuthInfo> {
    const data = await this.call<SlackApiResponse & { team_id: string; team: string; user_id: string; user: string; url?: string }>('auth.test');
    return { teamId: data.team_id, teamName: data.team, userId: data.user_id, userName: data.user, url: data.url };
  }

  /** Every member of the workspace, across pages; bots and deactivated accounts only when asked. */
  async listUsers(options: SlackUserListOptions = {}): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    let cursor = '';
    do {
      const data = await this.call<SlackApiResponse & { members: RawUser[] }>('users.list', {
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      users.push(...(data.members ?? []).map(toUser));
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return users.filter((u) => (options.includeDeleted || !u.deleted) && (options.includeBots || !u.isBot));
  }

  /** One user, by id (U…, W…) or by email address. */
  async getUser(idOrEmail: string): Promise<SlackUser> {
    const key = idOrEmail.trim();
    if (!key) {
      throw new CliError('INVALID_PARAMS', 'A user id or email address is required', 'See: agentio slack users list');
    }
    if (isUserId(key)) {
      const data = await this.call<SlackApiResponse & { user: RawUser }>('users.info', { user: key });
      return toUser(data.user);
    }
    if (!isEmail(key)) {
      throw new CliError('INVALID_PARAMS', `"${key}" is neither a Slack user id (U…) nor an email address`);
    }
    const data = await this.call<SlackApiResponse & { user: RawUser }>('users.lookupByEmail', { email: key });
    return toUser(data.user);
  }

  /** Channels visible to you: every public one, and the private ones you belong to. */
  async listChannels(options: SlackChannelListOptions = {}): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor = '';
    do {
      const data = await this.call<SlackApiResponse & { channels: RawChannel[] }>('conversations.list', {
        types: options.privateOnly ? 'private_channel' : 'public_channel,private_channel',
        exclude_archived: options.includeArchived ? 'false' : 'true',
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      channels.push(...(data.channels ?? []).map(toChannel));
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return channels;
  }

  /** One channel, by id (C…, G…) or by name, with or without #. */
  async getChannel(idOrName: string): Promise<SlackChannel> {
    const key = idOrName.trim();
    if (!key) throw new CliError('INVALID_PARAMS', 'A channel id or name is required', 'See: agentio slack channels list');
    if (isChannelId(key)) {
      const data = await this.call<SlackApiResponse & { channel: RawChannel }>('conversations.info', { channel: key, include_num_members: 'true' });
      return toChannel(data.channel);
    }
    const name = checkChannelName(key);
    const found = (await this.listChannels({ includeArchived: true })).find((c) => c.name === name);
    if (!found) {
      throw new CliError('NOT_FOUND', `No channel named #${name} is visible to you`,
        'Private channels are visible only to their members; see: agentio slack channels list');
    }
    return found;
  }

  /** The conversations you belong to, of the given types; archived ones left out. */
  async listMyConversations(types: SlackConversationType[]): Promise<SlackConversation[]> {
    const conversations: SlackConversation[] = [];
    let cursor = '';
    do {
      const data = await this.call<SlackApiResponse & { channels: RawConversation[] }>('users.conversations', {
        types: types.map((t) => CONVERSATION_TYPES[t]).join(','),
        exclude_archived: 'true',
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      conversations.push(...(data.channels ?? []).map(toConversation));
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return conversations;
  }

  /** A conversation's messages in the range, oldest first: top-level ones, and replies also sent to the channel. */
  async history(channel: string, range: SlackMessageRange): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor = '';
    do {
      const data = await this.call<SlackApiResponse & { messages: RawMessage[] }>('conversations.history', {
        channel,
        oldest: slackTs(range.since),
        latest: slackTs(range.until),
        inclusive: 'true',
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...(data.messages ?? []).map((m) => toMessage(m, 'history')));
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return messages.sort((a, b) => compareTs(a.ts, b.ts));
  }

  /** Every reply in a thread, oldest first, without its parent. */
  async replies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const replies: SlackMessage[] = [];
    let cursor = '';
    do {
      const data = await this.call<SlackApiResponse & { messages: RawMessage[] }>('conversations.replies', {
        channel,
        ts: threadTs,
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      replies.push(...(data.messages ?? []).filter((m) => m.ts !== threadTs).map((m) => toMessage(m, 'history')));
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return replies.sort((a, b) => compareTs(a.ts, b.ts));
  }

  /** The message that started a thread; undefined when Slack answers with another one. */
  async threadParent(channel: string, threadTs: string): Promise<SlackMessage | undefined> {
    const data = await this.call<SlackApiResponse & { messages: RawMessage[] }>('conversations.replies', {
      channel, ts: threadTs, limit: '1',
    });
    const first = data.messages?.[0];
    return first?.ts === threadTs ? toMessage(first, 'history') : undefined;
  }

  /** What search finds in the range, oldest first, in every conversation you can see, including some you are not in. */
  async searchMessages(range: SlackMessageRange): Promise<SlackSearchResult> {
    const matches: SlackSearchMatch[] = [];
    const query = searchQuery(range);
    let truncated = false;
    for (let page = 1, pages = 1; page <= pages; page++) {
      let data: SlackApiResponse & { messages?: { matches?: RawSearchMatch[]; paging?: { pages?: number } } };
      try {
        data = await this.call('search.messages', {
          query, sort: 'timestamp', sort_dir: 'asc', count: String(SEARCH_PAGE_SIZE), page: String(page),
        });
      } catch (error) {
        // Rate-limited past the retries after some pages: keep what was read.
        if (page > 1 && error instanceof CliError && error.code === 'RATE_LIMITED') return { matches, truncated: true };
        throw error;
      }
      const total = data.messages?.paging?.pages ?? 1;
      truncated = total > SEARCH_MAX_PAGES;
      pages = Math.min(total, SEARCH_MAX_PAGES);
      for (const raw of data.messages?.matches ?? []) {
        const channelId = raw.channel?.id;
        if (!channelId || typeof raw.ts !== 'string') continue;
        const message = toMessage({ ...raw, ts: raw.ts, thread_ts: undefined }, 'search');
        matches.push({ channelId, message: { ...message, threadTs: threadTsFromPermalink(raw.permalink) } });
      }
    }
    return { matches, truncated };
  }

  /** Every canvas you can see. files.list filters after paging, so every page is read. */
  async listCanvases(options: { user?: string } = {}): Promise<SlackCanvasList> {
    const canvases: SlackCanvas[] = [];
    let truncated = false;
    for (let page = 1, pages = 1; page <= pages; page++) {
      const data = await this.call<SlackApiResponse & { files?: RawFile[]; paging?: { pages?: number } }>('files.list', {
        types: 'canvas', count: String(FILES_PAGE_SIZE), page: String(page), ...(options.user ? { user: options.user } : {}),
      });
      const total = data.paging?.pages ?? 1;
      truncated = total > FILES_MAX_PAGES;
      pages = Math.min(total, FILES_MAX_PAGES);
      canvases.push(...(data.files ?? []).filter((f) => f.filetype === CANVAS_FILETYPE).map(toCanvas));
    }
    return { canvases, truncated };
  }

  /** One canvas, with its download link; NOT_FOUND when the id is a file of another kind. */
  async canvasInfo(id: string): Promise<SlackCanvas> {
    return toCanvas(await this.canvasFile(id));
  }

  /** One canvas and its HTML. */
  async canvasHtml(id: string): Promise<{ canvas: SlackCanvas; html: string }> {
    const file = await this.canvasFile(id);
    return { canvas: toCanvas(file), html: await this.downloadCanvasHtml(file.url_private_download) };
  }

  private async canvasFile(id: string): Promise<RawFile> {
    const data = await this.call<SlackApiResponse & { file: RawFile }>('files.info', { file: id });
    if (data.file?.filetype !== CANVAS_FILETYPE) throw new CliError('NOT_FOUND', `${id} is a file, not a canvas`);
    return data.file;
  }

  /** A canvas's HTML, from files.slack.com only; a redirect is refused rather than followed with the token. */
  async downloadCanvasHtml(url: string | undefined): Promise<string> {
    const target = checkDownloadUrl(url);
    const token = this.token();
    let response: Response;
    try {
      response = await fetch(target, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (/redirect/i.test(String(error))) throw this.redirected();
      throw new CliError('NETWORK_ERROR', 'Cannot download the canvas from files.slack.com', 'Check your network connection');
    }
    if (response.status >= 300 && response.status < 400) throw this.redirected();
    if (response.status === 401 || response.status === 403) {
      throw new CliError('PERMISSION_DENIED', 'Slack refused the canvas download', 'Check that the token has files:read and that the canvas is shared with you');
    }
    if (response.status === 404) throw new CliError('NOT_FOUND', 'The canvas content is gone');
    if (!response.ok) throw new CliError('API_ERROR', `Slack answered the canvas download with HTTP ${response.status}`);
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
      throw new CliError('API_ERROR', 'Slack sent the canvas in an unexpected format, not HTML');
    }
    return response.text();
  }

  private redirected(): CliError {
    return new CliError('PERMISSION_DENIED', 'Slack redirected the canvas download, usually to a sign-in page',
      'Check that the token has files:read and that the canvas is shared with you');
  }

  /**
   * The file ids of a channel's canvases, each once. Slack lists them as canvas tabs; its docs
   * name properties.canvas instead, so both are read.
   */
  async channelCanvasIds(channelId: string): Promise<string[]> {
    const data = await this.call<SlackApiResponse & { channel: { properties?: RawChannelProperties } }>('conversations.info', { channel: channelId });
    const properties = data.channel?.properties;
    const ids = [properties?.canvas?.file_id, ...(properties?.tabs ?? []).filter((t) => t.type === 'canvas').map((t) => t.data?.file_id)];
    return [...new Set(ids.filter((id): id is string => !!id))];
  }

  /** A new canvas, standalone with a title or a channel's; its id. */
  async createCanvas(markdown: string, target: { title: string } | { channelId: string }): Promise<string> {
    const content: Record<string, string> = markdown ? { document_content: JSON.stringify(markdownContent(markdown)) } : {};
    const data = 'title' in target
      ? await this.call<SlackApiResponse & { canvas_id: string }>('canvases.create', { title: target.title, ...content })
      : await this.call<SlackApiResponse & { canvas_id: string }>('conversations.canvases.create', { channel_id: target.channelId, ...content });
    return data.canvas_id;
  }

  /** Replaces a canvas's whole content. */
  async replaceCanvas(id: string, markdown: string): Promise<void> {
    await this.call('canvases.edit', { canvas_id: id, changes: JSON.stringify([{ operation: 'replace', document_content: markdownContent(markdown) }]) });
  }

  async renameCanvas(id: string, title: string): Promise<void> {
    await this.call('canvases.edit', { canvas_id: id, changes: JSON.stringify([{ operation: 'rename', title_content: markdownContent(title) }]) });
  }

  /** Gives access; users and channels go in separate calls of at most 20 ids. */
  async setCanvasAccess(id: string, level: SlackCanvasAccessLevel, targets: SlackCanvasTargets): Promise<void> {
    await this.changeAccess('canvases.access.set', { canvas_id: id, access_level: level }, targets, 'shared with');
  }

  /** Removes access; users and channels go in separate calls of at most 20 ids. */
  async removeCanvasAccess(id: string, targets: SlackCanvasTargets): Promise<void> {
    await this.changeAccess('canvases.access.delete', { canvas_id: id }, targets, 'unshared from');
  }

  /** One call per batch; a failure after some batches says who was already changed, so a retry can be scoped. */
  private async changeAccess(method: string, params: Record<string, string>, targets: SlackCanvasTargets, done: string): Promise<void> {
    const batches: [string, string[]][] = [];
    for (const [field, ids] of [['user_ids', targets.users], ['channel_ids', targets.channels]] as const) {
      for (const batch of chunk(ids, ACCESS_BATCH)) batches.push([field, batch]);
    }
    const changed: string[] = [];
    for (const [field, ids] of batches) {
      try {
        await this.call(method, { ...params, [field]: JSON.stringify(ids) });
      } catch (error) {
        if (!(error instanceof CliError) || changed.length === 0) throw error;
        throw new CliError(error.code, `${error.message}. Already ${done}: ${changed.join(', ')}`, error.suggestion);
      }
      changed.push(...ids);
    }
  }

  async deleteCanvas(id: string): Promise<void> {
    await this.call('canvases.delete', { canvas_id: id });
  }

  /** A new channel, with its topic and purpose; you are its first member. */
  async createChannel(name: string, options: SlackChannelCreateOptions = {}): Promise<SlackChannel> {
    const checked = checkChannelName(name);
    const update = { topic: options.topic, purpose: options.purpose };
    this.checkUpdate(update);
    const data = await this.call<SlackApiResponse & { channel: RawChannel }>('conversations.create', {
      name: checked,
      is_private: options.isPrivate ? 'true' : 'false',
    });
    const channel = toChannel(data.channel);
    try {
      return await this.applyUpdate(channel, update);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // The channel exists now; say so, or a retry would fail with name_taken.
      throw new CliError(error.code, `Channel #${channel.name} (${channel.id}) was created, but ${error.message}`,
        `Retry with: agentio slack channels set ${channel.id}${update.topic !== undefined ? ' --topic …' : ''}${update.purpose !== undefined ? ' --purpose …' : ''}`);
    }
  }

  /** Change a channel's name, topic or purpose; what is not given is left alone. */
  async updateChannel(idOrName: string, update: SlackChannelUpdate): Promise<SlackChannel> {
    const checked = this.checkUpdate(update);
    if (checked.name === undefined && update.topic === undefined && update.purpose === undefined) {
      throw new CliError('INVALID_PARAMS', 'Nothing to change', 'Give at least one of --name, --topic or --purpose');
    }
    let channel = await this.getChannel(idOrName);
    if (checked.name !== undefined && checked.name !== channel.name) {
      const data = await this.call<SlackApiResponse & { channel: RawChannel }>('conversations.rename', { channel: channel.id, name: checked.name });
      channel = toChannel(data.channel);
    }
    return this.applyUpdate(channel, update);
  }

  /** Archive a channel: read-only and out of the sidebar, with its history kept. */
  async archiveChannel(idOrName: string): Promise<SlackChannelChange> {
    return this.setArchived(idOrName, true);
  }

  /** Bring an archived channel back. */
  async unarchiveChannel(idOrName: string): Promise<SlackChannelChange> {
    return this.setArchived(idOrName, false);
  }

  /**
   * Leave channels, one at a time. All are looked up first, so a wrong name
   * leaves none; channels you are not in are reported unchanged. Leaving a
   * private channel cannot be undone with this token: it no longer sees it.
   */
  async leaveChannels(idsOrNames: string[]): Promise<SlackChannelChange[]> {
    const keys = [...new Set(idsOrNames.map((c) => c.trim()))];
    if (keys.length === 0 || keys.includes('')) throw new CliError('INVALID_PARAMS', 'Give at least one channel id or name');
    const channels: SlackChannel[] = [];
    for (const key of keys) channels.push(await this.getChannel(key));
    const results: SlackChannelChange[] = [];
    for (const channel of [...new Map(channels.map((c) => [c.id, c])).values()]) {
      if (!channel.isMember) {
        results.push({ channel, changed: false });
        continue;
      }
      try {
        await this.call('conversations.leave', { channel: channel.id });
      } catch (error) {
        const left = results.filter((r) => r.changed).map((r) => `#${r.channel.name}`);
        if (!(error instanceof CliError) || left.length === 0) throw error;
        throw new CliError(error.code, `${error.message} (leaving #${channel.name}; already left: ${left.join(', ')})`, error.suggestion);
      }
      results.push({ channel: { ...channel, isMember: false }, changed: true });
    }
    return results;
  }

  private async setArchived(idOrName: string, archived: boolean): Promise<SlackChannelChange> {
    const channel = await this.getChannel(idOrName);
    if (channel.isArchived === archived) return { channel, changed: false };
    await this.call(archived ? 'conversations.archive' : 'conversations.unarchive', { channel: channel.id });
    return { channel: { ...channel, isArchived: archived }, changed: true };
  }

  /** The members of a channel, as users. */
  async channelMembers(idOrName: string): Promise<{ channel: SlackChannel; members: SlackUser[] }> {
    const channel = await this.getChannel(idOrName);
    const ids = await this.memberIds(channel.id);
    const known = new Map((await this.listUsers({ includeDeleted: true, includeBots: true })).map((u) => [u.id, u]));
    const members = ids.map((id) => known.get(id) ?? { id, name: id, isAdmin: false, isOwner: false, isBot: false, deleted: false, isRestricted: false });
    return { channel, members };
  }

  /**
   * Add people to a channel at once; Slack asks nobody to accept. Every user is
   * looked up first, so one unknown email invites nobody. Members are skipped.
   */
  async inviteToChannel(idOrName: string, users: string[]): Promise<SlackMembershipResult> {
    const { channel, people, members } = await this.prepareMembership(idOrName, users);
    const changed = people.filter((u) => !members.has(u.id));
    const skipped = people.filter((u) => members.has(u.id));
    if (changed.length > 0) {
      await this.call('conversations.invite', { channel: channel.id, users: changed.map((u) => u.id).join(',') });
    }
    return { channel, changed, skipped };
  }

  /** Remove people from a channel. Every user is looked up first; non-members are skipped. */
  async uninviteFromChannel(idOrName: string, users: string[]): Promise<SlackMembershipResult> {
    const { channel, people, members } = await this.prepareMembership(idOrName, users);
    const changed: SlackUser[] = [];
    const skipped = people.filter((u) => !members.has(u.id));
    for (const user of people.filter((u) => members.has(u.id))) {
      try {
        await this.call('conversations.kick', { channel: channel.id, user: user.id });
      } catch (error) {
        if (!(error instanceof CliError) || changed.length === 0) throw error;
        // Slack removes one user per call; say who is already out.
        throw new CliError(error.code, `${error.message} (removing ${user.email ?? user.id}; already removed: ${changed.map((u) => u.email ?? u.id).join(', ')})`, error.suggestion);
      }
      changed.push(user);
    }
    return { channel, changed, skipped };
  }

  private async prepareMembership(idOrName: string, users: string[]): Promise<{ channel: SlackChannel; people: SlackUser[]; members: Set<string> }> {
    const keys = [...new Set(users.map((u) => u.trim()))];
    if (keys.length === 0 || keys.includes('')) throw new CliError('INVALID_PARAMS', 'Give at least one user id or email address');
    const malformed = keys.find((key) => !isUserId(key) && !isEmail(key));
    if (malformed) {
      throw new CliError('INVALID_PARAMS', `"${malformed}" is neither a Slack user id (U…) nor an email address. Nothing was changed`);
    }
    const channel = await this.getChannel(idOrName);
    if (channel.isArchived) throw new CliError('INVALID_PARAMS', `#${channel.name} is archived`);
    // Past a few users, one users.list costs fewer calls than a lookup each (Tier 3, ~50 a minute).
    const directory = keys.length >= BULK_LOOKUP_MIN ? this.directoryOf(await this.listUsers({ includeDeleted: true, includeBots: true })) : null;
    const people: SlackUser[] = [];
    for (const key of keys) {
      const listed = directory?.get(isUserId(key) ? key : key.toLowerCase());
      if (listed) {
        people.push(listed);
        continue;
      }
      // Not in the list (or no list): ask Slack for this one, which also gives the precise error.
      try {
        people.push(await this.getUser(key));
      } catch (error) {
        if (error instanceof CliError && error.code === 'NOT_FOUND') {
          throw new CliError('NOT_FOUND', `${error.message}: ${key}. Nothing was changed`);
        }
        throw error;
      }
    }
    // The same person given by id and by email counts once.
    const unique = [...new Map(people.map((u) => [u.id, u])).values()];
    return { channel, people: unique, members: new Set(await this.memberIds(channel.id)) };
  }

  /** Users by id and by lowercase email. */
  private directoryOf(users: SlackUser[]): Map<string, SlackUser> {
    const directory = new Map<string, SlackUser>();
    for (const user of users) {
      directory.set(user.id, user);
      if (user.email) directory.set(user.email.toLowerCase(), user);
    }
    return directory;
  }

  private async memberIds(channelId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor = '';
    do {
      const data = await this.call<SlackApiResponse & { members: string[] }>('conversations.members', {
        channel: channelId,
        limit: String(PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...(data.members ?? []));
      cursor = data.response_metadata?.next_cursor ?? '';
    } while (cursor);
    return ids;
  }

  private checkUpdate(update: SlackChannelUpdate): SlackChannelUpdate {
    if (update.topic !== undefined) checkChannelText('topic', update.topic);
    if (update.purpose !== undefined) checkChannelText('purpose', update.purpose);
    return { ...update, ...(update.name !== undefined ? { name: checkChannelName(update.name) } : {}) };
  }

  private async applyUpdate(channel: SlackChannel, update: SlackChannelUpdate): Promise<SlackChannel> {
    let result = channel;
    if (update.topic !== undefined && update.topic !== channel.topic) {
      await this.call('conversations.setTopic', { channel: channel.id, topic: update.topic });
      result = { ...result, topic: update.topic || undefined };
    }
    if (update.purpose !== undefined && update.purpose !== channel.purpose) {
      await this.call('conversations.setPurpose', { channel: channel.id, purpose: update.purpose });
      result = { ...result, purpose: update.purpose || undefined };
    }
    return result;
  }

  /** One Web API call: form-encoded POST with the user token, retried on 429. */
  /** The user token; a webhook profile has none. */
  private token(): string {
    if (!isTokenCredentials(this.credentials)) {
      throw new CliError('INVALID_PARAMS', 'This Slack profile is a webhook, which can only send messages',
        'Add a profile with a user token: agentio slack profile add');
    }
    return this.credentials.token;
  }

  private async call<T extends SlackApiResponse>(method: string, params: Record<string, string> = {}): Promise<T> {
    const token = this.token();

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${SLACK_API_URL}/${method}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new CliError('NETWORK_ERROR', `Cannot reach Slack (${method})`, 'Check your network connection');
      }

      if (response.status === 429) {
        const wait = Number(response.headers.get('Retry-After'));
        const seconds = Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_RETRY_WAIT_S) : 1;
        if (attempt < MAX_RETRIES) {
          await this.sleep(seconds * 1000);
          continue;
        }
        throw new CliError('RATE_LIMITED', `Slack rate limit reached on ${method}`, 'Wait a minute and try again');
      }

      let data: T;
      try {
        data = (await response.json()) as T;
      } catch {
        throw new CliError(httpStatusToErrorCode(response.status), `Slack answered ${method} with HTTP ${response.status}, not JSON`);
      }
      if (!data || typeof data !== 'object' || data.ok !== true) throw this.errorFor(method, data);
      return data;
    }
  }

  private errorFor(method: string, data: SlackApiResponse | null): CliError {
    const error = typeof data?.error === 'string' ? data.error : 'unknown_error';
    if (error === 'missing_scope') {
      const needed = typeof data?.needed === 'string' ? data.needed : 'unknown';
      return new SlackApiError(error, 'PERMISSION_DENIED', `The Slack token lacks the ${needed} scope for ${method}`,
        `Add ${needed} under User Token Scopes in your Slack app, reinstall it, then run: agentio slack profile add`);
    }
    const known = API_ERRORS[error];
    if (known) return new SlackApiError(error, known.code, known.message, known.suggestion);
    return new SlackApiError(error, 'API_ERROR', `Slack ${method} failed: ${error}`);
  }

  private async sendViaWebhook(options: SlackSendOptions): Promise<SlackSendResult> {
    const webhookUrl = (this.credentials as SlackWebhookCredentials).webhookUrl;

    if (!webhookUrl?.trim() || !webhookUrl.startsWith('https://')) {
      throw new CliError(
        'INVALID_PARAMS',
        'Invalid webhook URL - must be HTTPS',
        'Check the webhook URL configuration',
      );
    }

    const payload = options.payload ?? { text: options.text };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new CliError(
          httpStatusToErrorCode(response.status),
          `Failed to send message via webhook: ${response.status} ${error}`,
          'Check that the webhook URL is valid and the app has permission to post',
        );
      }

      return {
        success: true,
        isJsonPayload: !!options.payload,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        'NETWORK_ERROR',
        `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the webhook URL is correct and accessible',
      );
    }
  }
}
