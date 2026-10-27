import { CliError } from '../../utils/errors';
import { parseDateOption } from '../../utils/options';
import { compareTs, messagePermalink, SLACKBOT_ID, SlackApiError, type SlackClient } from './client';
import { SlackDirectory } from './directory';
import { formatSlackText } from './format';
import type {
  SlackConversation,
  SlackDirectoryEntry,
  SlackConversationMessages,
  SlackConversationType,
  SlackMessage,
  SlackMessageRange,
  SlackMessagesResult,
  SlackThreadParent,
} from './types';

export const SLACK_CONVERSATION_TYPES: SlackConversationType[] = ['channel', 'private', 'dm', 'group'];

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** --since and --until, checked against each other and the clock. */
export function checkRange(since: string | undefined, until: string | undefined, now = new Date()): SlackMessageRange {
  const from = parseDateOption(since, '--since');
  if (!from) throw new CliError('INVALID_PARAMS', '--since is required', 'For example: --since 2026-10-20');
  const end = parseDateOption(until, '--until');
  // A date alone means the end of that day, so the day is included.
  const to = end && BARE_DATE.test(until!.trim()) ? new Date(end.getTime() + DAY_MS - 1) : end ?? now;
  if (from > now) throw new CliError('INVALID_PARAMS', `--since ${since} is in the future`);
  if (from > to) throw new CliError('INVALID_PARAMS', `--since ${since} is after --until ${until}`);
  return { since: from, until: to };
}

/** --types as a list; absent means every type. */
export function checkTypes(input: string | undefined): SlackConversationType[] {
  if (input === undefined) return SLACK_CONVERSATION_TYPES;
  const types = input.split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = types.filter((t) => !SLACK_CONVERSATION_TYPES.includes(t as SlackConversationType));
  if (types.length === 0 || unknown.length > 0) {
    throw new CliError('INVALID_PARAMS', `Unknown --types: ${unknown.join(', ') || '(empty)'}`,
      `Use a comma-separated list of: ${SLACK_CONVERSATION_TYPES.join(', ')}`);
  }
  return [...new Set(types)] as SlackConversationType[];
}

/** Whether a Slack timestamp is in the range, both ends included. */
export function inRange(ts: string, range: SlackMessageRange): boolean {
  const ms = Number(ts) * 1000;
  return ms >= range.since.getTime() && ms <= range.until.getTime();
}

/** The conversations --channel names, by id or name, each once; one not in `all` is NOT_FOUND. */
export function pickConversations(all: SlackConversation[], wanted: string[] | undefined): SlackConversation[] {
  if (!wanted?.length) return all;
  const picked = new Map<string, SlackConversation>();
  for (const input of wanted) {
    const key = input.trim().replace(/^#/, '');
    const found = all.find((c) => c.id === key || c.name === key);
    if (!found) {
      throw new CliError('NOT_FOUND', `You are not in a conversation named ${input.trim()}`,
        'See: agentio slack channels list. Check --types too; for a public channel you are not in, add --include-public');
    }
    picked.set(found.id, found);
  }
  return [...picked.values()];
}

const isReply = (m: SlackMessage) => !!m.threadTs && m.threadTs !== m.ts;

/**
 * Adds messages to a conversation, each once across both passes. A reply goes
 * under its parent when the parent is here; otherwise it stands alone with
 * `parent` set, to be named later.
 */
export function placeMessages(conversation: SlackConversationMessages, incoming: SlackMessage[], seen: Set<string>): void {
  for (const message of incoming) {
    const key = `${conversation.id}:${message.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isReply(message)) {
      conversation.messages.push(message);
      continue;
    }
    const parent = conversation.messages.find((m) => m.ts === message.threadTs && !m.parent);
    if (parent) parent.replies.push(message);
    else conversation.messages.push({ ...message, parent: { ts: message.threadTs! } });
  }
}

/** Top-level messages oldest first, then replies to older threads, grouped by thread; replies oldest first. */
export function sortConversation(conversation: SlackConversationMessages): void {
  for (const m of conversation.messages) m.replies.sort((a, b) => compareTs(a.ts, b.ts));
  conversation.messages.sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0)
    || compareTs(a.parent?.ts ?? '', b.parent?.ts ?? '')
    || compareTs(a.ts, b.ts));
}

/** Messages and replies alike. */
export function countMessages(conversation: SlackConversationMessages): number {
  return conversation.messages.reduce((n, m) => n + 1 + m.replies.length, 0);
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Every user id the names are needed for: authors, older threads' parents, mentions, direct messages. */
export function referencedUsers(conversations: SlackConversationMessages[]): Set<string> {
  const ids = new Set<string>();
  const addText = (text: string | undefined) => { for (const [, id] of (text ?? '').matchAll(MENTION)) ids.add(id); };
  const visit = (m: SlackMessage) => {
    if (m.user) ids.add(m.user);
    if (m.parent?.user) ids.add(m.parent.user);
    addText(m.text);
    addText(m.parent?.text);
    m.replies.forEach(visit);
  };
  for (const c of conversations) {
    if (c.user) ids.add(c.user);
    c.messages.forEach(visit);
  }
  return ids;
}

export interface ResolveNamesOptions {
  /** Keep Slack's text as sent: mentions and links left as markup. */
  raw?: boolean;
}

/**
 * User ids to names, in authors (with their real and display names), older
 * threads' parents and direct messages' names; unless `raw`, text markup
 * (mentions, channel links, links) made readable.
 */
export function resolveNames(conversations: SlackConversationMessages[], users: SlackDirectoryEntry[], options: ResolveNamesOptions = {}): void {
  const byId = new Map(users.map((u) => [u.id, u]));
  const names = new Map(users.map((u) => [u.id, u.displayName || u.realName || u.name]));
  const channels = new Map(conversations.filter((c) => c.type === 'channel' || c.type === 'private').map((c) => [c.id, c.name]));
  const nameOf = (id: string | undefined, botName?: string) => (id ? names.get(id) ?? id : botName ?? 'unknown');
  const text = (value: string) => (options.raw ? value : formatSlackText(value, { users: names, channels }));
  const person = (target: { realName?: string; displayName?: string }, id: string | undefined) => {
    const entry = id ? byId.get(id) : undefined;
    if (entry?.realName) target.realName = entry.realName;
    if (entry?.displayName) target.displayName = entry.displayName;
  };
  const fix = (m: SlackMessage) => {
    m.userName = nameOf(m.user, m.botName);
    person(m, m.user);
    m.text = text(m.text);
    if (m.parent && (m.parent.user || m.parent.userName)) {
      m.parent.userName = nameOf(m.parent.user, m.parent.userName);
      person(m.parent, m.parent.user);
    }
    if (m.parent?.text) m.parent.text = text(m.parent.text);
    m.replies.forEach(fix);
  };
  for (const c of conversations) {
    if (c.type === 'dm' && c.user) c.name = nameOf(c.user);
    c.messages.forEach(fix);
  }
}

/** A link on every message, reply and older thread's parent; an older thread's parent is shared, so set once. */
export function addPermalinks(conversations: SlackConversationMessages[], teamUrl: string): void {
  for (const c of conversations) {
    const visit = (m: SlackMessage) => {
      m.permalink = messagePermalink(teamUrl, c.id, m.ts, m.threadTs);
      if (m.parent) m.parent.permalink = messagePermalink(teamUrl, c.id, m.parent.ts);
      m.replies.forEach(visit);
    };
    c.messages.forEach(visit);
  }
}

export interface SlackMessagesOptions {
  range: SlackMessageRange;
  types?: SlackConversationType[];
  /** --channel values: ids or names. */
  channels?: string[];
  /** Also read public channels you are not in, without joining them. */
  includePublic?: boolean;
  /** Keep Slack's text markup as sent. */
  raw?: boolean;
  /** For stderr. */
  onWarning?: (message: string) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Slack errors that lose one conversation or thread, not the whole run. */
const SKIPPABLE = new Set(['channel_not_found', 'not_in_channel', 'thread_not_found']);

/** Search failures that leave pass A's results usable: a missing search:read, or rate limits. */
const searchSkippable = (error: unknown): error is CliError => error instanceof CliError
  && (error.code === 'RATE_LIMITED' || (error instanceof SlackApiError && error.slackError === 'missing_scope'));
/** A public channel you are not in can also be refused for a missing scope or for not being a member; that loses only it. */
const NOT_MEMBER_SKIPPABLE = new Set(['missing_scope', 'not_in_channel']);
const skippable = (error: unknown, conversation?: SlackConversation) => error instanceof SlackApiError
  && (SKIPPABLE.has(error.slackError) || (conversation?.isMember === false && NOT_MEMBER_SKIPPABLE.has(error.slackError)));
const labelOf = (c: SlackConversation) => {
  if (c.type === 'dm') return `the direct message with ${c.name}`;
  return c.isMember ? `#${c.name}` : `#${c.name} (public, not a member)`;
};

/** The conversations to read: yours, without Slackbot's direct message, then with --include-public every other public channel. */
async function listConversations(client: SlackClient, types: SlackConversationType[], includePublic: boolean): Promise<SlackConversation[]> {
  if (includePublic && !types.includes('channel')) {
    throw new CliError('INVALID_PARAMS', '--include-public reads public channels, which --types leaves out', 'Add channel to --types');
  }
  // Slackbot's direct message cannot be read through the API; it is left out rather than warned about each run.
  const mine = (await client.listMyConversations(types)).filter((c) => !(c.type === 'dm' && c.user === SLACKBOT_ID));
  if (!includePublic) return mine;
  const ids = new Set(mine.map((c) => c.id));
  const others = (await client.listPublicChannels())
    .filter((c) => !ids.has(c.id))
    .map((c): SlackConversation => ({ id: c.id, name: c.name, type: 'channel', isMember: false }));
  return [...mine, ...others];
}

/**
 * Every message in the range, in the conversations you are in (and with
 * includePublic the public channels you are not in): each conversation's
 * history and the threads under it, then search for replies in threads that
 * started before the range. Read-only: nothing is joined or marked read.
 */
export async function collectMessages(client: SlackClient, options: SlackMessagesOptions): Promise<SlackMessagesResult> {
  const { range } = options;
  const warn = options.onWarning ?? (() => {});
  const types = options.types ?? SLACK_CONVERSATION_TYPES;
  const listed = pickConversations(await listConversations(client, types, !!options.includePublic), options.channels);
  const conversations = new Map(listed.map((c) => [c.id, { ...c, messages: [] as SlackMessage[] }]));
  const seen = new Set<string>();

  let done = 0;
  const total = conversations.size;
  for (const conversation of [...conversations.values()]) {
    try {
      await readHistory(client, conversation, range, seen, warn);
    } catch (error) {
      if (!skippable(error, conversation)) throw error;
      warn(`Could not read ${labelOf(conversation)}: ${(error as Error).message}`);
      // Left out entirely: a few search results would make it look read.
      conversations.delete(conversation.id);
    }
    options.onProgress?.(++done, total);
  }

  try {
    await readSearch(client, conversations, range, seen, warn);
  } catch (error) {
    if (!searchSkippable(error)) throw error;
    warn(`Search failed (${error.message}); replies in threads started before --since may be missing`);
  }
  await nameOlderThreads(client, conversations);

  const found = [...conversations.values()].filter((c) => c.messages.length > 0);
  if (found.length > 0) {
    const auth = await client.authTest();
    const directory = new SlackDirectory(client, `${auth.teamId}:${auth.userId}`);
    resolveNames(found, await directory.entries(referencedUsers(found)), { raw: options.raw });
    if (auth.url) addPermalinks(found, auth.url);
  }
  for (const c of found) sortConversation(c);
  found.sort((a, b) => countMessages(b) - countMessages(a));
  return { since: range.since.toISOString(), until: range.until.toISOString(), conversations: found };
}

/** Pass A for one conversation: its history, then the in-range replies of each thread in it. */
async function readHistory(
  client: SlackClient, conversation: SlackConversationMessages, range: SlackMessageRange,
  seen: Set<string>, warn: (message: string) => void,
): Promise<void> {
  const history = await client.history(conversation.id, range);
  const topLevel = history.filter((m) => !isReply(m));
  placeMessages(conversation, topLevel, seen);
  for (const parent of topLevel.filter((m) => m.replyCount > 0)) {
    try {
      const replies = await client.replies(conversation.id, parent.ts);
      placeMessages(conversation, replies.filter((r) => inRange(r.ts, range)), seen);
    } catch (error) {
      if (!skippable(error, conversation)) throw error;
      warn(`Could not read a thread in ${labelOf(conversation)}: ${(error as Error).message}`);
    }
  }
  // Replies also sent to the channel: under their parent if it is here, else on their own.
  placeMessages(conversation, history.filter(isReply), seen);
}

/** Pass B: what search finds in your conversations, in the exact range, merged into what history found. */
async function readSearch(
  client: SlackClient, conversations: Map<string, SlackConversationMessages>, range: SlackMessageRange,
  seen: Set<string>, warn: (message: string) => void,
): Promise<void> {
  const { matches: found, truncated } = await client.searchMessages(range);
  if (truncated) warn('Search stopped before the end (Slack\'s 10,000-result cap or rate limit); replies in threads started before --since may be missing');
  const matches = found
    .filter((m) => conversations.has(m.channelId) && inRange(m.message.ts, range))
    .sort((a, b) => compareTs(a.message.ts, b.message.ts));
  for (const match of matches) placeMessages(conversations.get(match.channelId)!, [match.message], seen);
}

/** Reads each older thread's parent once, to name the thread; a parent that is gone keeps only its ts. */
async function nameOlderThreads(client: SlackClient, conversations: Map<string, SlackConversationMessages>): Promise<void> {
  for (const conversation of conversations.values()) {
    const parents = new Map<string, SlackThreadParent>();
    for (const message of conversation.messages) {
      if (!message.parent) continue;
      let parent = parents.get(message.parent.ts);
      if (!parent) {
        parent = { ts: message.parent.ts };
        try {
          const found = await client.threadParent(conversation.id, parent.ts);
          if (found) Object.assign(parent, { user: found.user, userName: found.botName, text: found.text, files: found.files });
        } catch (error) {
          if (!skippable(error)) throw error;
        }
        parents.set(parent.ts, parent);
      }
      message.parent = parent;
    }
  }
}
