import { CliError } from '../../utils/errors';
import { parseDateOption } from '../../utils/options';
import { compareTs } from './client';
import type {
  SlackConversation,
  SlackConversationMessages,
  SlackConversationType,
  SlackMessage,
  SlackMessageRange,
  SlackUser,
} from './types';

export const SLACK_CONVERSATION_TYPES: SlackConversationType[] = ['channel', 'private', 'dm', 'group'];

/** --since and --until, checked against each other and the clock. */
export function checkRange(since: string | undefined, until: string | undefined, now = new Date()): SlackMessageRange {
  const from = parseDateOption(since, '--since');
  if (!from) throw new CliError('INVALID_PARAMS', '--since is required', 'For example: --since 2026-10-20');
  const to = parseDateOption(until, '--until') ?? now;
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

/** The conversations --channel names, by id or name, each once; one you are not in is NOT_FOUND. */
export function pickConversations(all: SlackConversation[], wanted: string[] | undefined): SlackConversation[] {
  if (!wanted?.length) return all;
  const picked = new Map<string, SlackConversation>();
  for (const input of wanted) {
    const key = input.trim().replace(/^#/, '');
    const found = all.find((c) => c.id === key || c.name === key);
    if (!found) {
      throw new CliError('NOT_FOUND', `You are not in a conversation named ${input.trim()}`,
        'See: agentio slack channels list. Check --types too');
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

/** User ids to names, in authors, mentions, older threads' parents, and direct messages' names. */
export function resolveNames(conversations: SlackConversationMessages[], users: SlackUser[]): void {
  const names = new Map(users.map((u) => [u.id, u.displayName || u.realName || u.name]));
  const nameOf = (id: string | undefined, botName?: string) => (id ? names.get(id) ?? id : botName ?? 'unknown');
  const mentions = (text: string) => text.replace(MENTION, (_, id: string) => `@${names.get(id) ?? id}`);
  const fix = (m: SlackMessage) => {
    m.userName = nameOf(m.user, m.botName);
    m.text = mentions(m.text);
    if (m.parent && (m.parent.user || m.parent.userName)) m.parent.userName = nameOf(m.parent.user, m.parent.userName);
    if (m.parent?.text) m.parent.text = mentions(m.parent.text);
    m.replies.forEach(fix);
  };
  for (const c of conversations) {
    if (c.type === 'dm' && c.user) c.name = nameOf(c.user);
    c.messages.forEach(fix);
  }
}
