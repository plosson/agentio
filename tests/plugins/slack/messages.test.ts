import { describe, expect, test } from 'bun:test';
import {
  checkRange, checkTypes, countMessages, inRange, pickConversations, placeMessages, resolveNames, sortConversation,
} from '../../../src/plugins/slack/messages';
import type { SlackConversation, SlackConversationMessages, SlackMessage, SlackUser } from '../../../src/plugins/slack/types';
import { CliError } from '../../../src/utils/errors';

const NOW = new Date('2026-10-27T12:00:00Z');
const msg = (ts: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  ts, text: `text ${ts}`, replyCount: 0, files: [], replies: [], source: 'history', ...extra,
});
const conv = (id = 'C1', extra: Partial<SlackConversationMessages> = {}): SlackConversationMessages => ({
  id, name: id.toLowerCase(), type: 'channel', messages: [], ...extra,
});
const user = (id: string, extra: Partial<SlackUser> = {}): SlackUser => ({
  id, name: id.toLowerCase(), isAdmin: false, isOwner: false, isBot: false, deleted: false, isRestricted: false, ...extra,
});
const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as CliError).code; }
  return 'no error';
};

describe('checkRange', () => {
  test('a bare date is midnight UTC; --until defaults to now', () => {
    const r = checkRange('2026-10-20', undefined, NOW);
    expect(r.since.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(r.until).toEqual(NOW);
  });

  test('missing, malformed, future and inverted ranges are refused', () => {
    expect(codeOf(() => checkRange(undefined, undefined, NOW))).toBe('INVALID_PARAMS');
    expect(codeOf(() => checkRange('', undefined, NOW))).toBe('INVALID_PARAMS');
    for (const bad of ['yesterday', '2026-13-01', '20/10/2026']) expect(codeOf(() => checkRange(bad, undefined, NOW))).toBe('INVALID_PARAMS');
    expect(codeOf(() => checkRange('2026-10-28', undefined, NOW))).toBe('INVALID_PARAMS');
    expect(codeOf(() => checkRange('2026-10-25', '2026-10-20', NOW))).toBe('INVALID_PARAMS');
    expect(codeOf(() => checkRange('2026-10-20', 'never', NOW))).toBe('INVALID_PARAMS');
  });

  test('since equal to until is allowed', () => {
    expect(codeOf(() => checkRange('2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z', NOW))).toBe('no error');
  });
});

describe('checkTypes', () => {
  test('absent means all four; spaces and repeats are tidied', () => {
    expect(checkTypes(undefined)).toEqual(['channel', 'private', 'dm', 'group']);
    expect(checkTypes(' dm , dm,channel ')).toEqual(['dm', 'channel']);
  });

  test('unknown, plural or empty types are refused, naming the valid ones', () => {
    for (const bad of ['dms', 'channels', '', ',', 'dm,im']) {
      expect(codeOf(() => checkTypes(bad))).toBe('INVALID_PARAMS');
    }
  });
});

describe('inRange', () => {
  const r = { since: new Date('2026-10-20T00:00:00Z'), until: new Date('2026-10-27T00:00:00Z') };
  test('both ends are inclusive', () => {
    expect(inRange('1792454400.000000', r)).toBe(true);
    expect(inRange('1792454399.999000', r)).toBe(false);
    expect(inRange(String(Date.parse('2026-10-27T00:00:00Z') / 1000) + '.000000', r)).toBe(true);
  });
});

describe('pickConversations', () => {
  const all: SlackConversation[] = [
    { id: 'C0GENERAL', name: 'general', type: 'channel' },
    { id: 'D0BOB', name: 'U0001', type: 'dm', user: 'U0001' },
  ];

  test('no --channel keeps all', () => {
    expect(pickConversations(all, undefined)).toEqual(all);
    expect(pickConversations(all, [])).toEqual(all);
  });

  test('the same conversation by id, by name and by #name is read once', () => {
    expect(pickConversations(all, ['C0GENERAL', 'general', ' #general '])).toEqual([all[0]]);
  });

  test('a conversation you are not in is NOT_FOUND, not an empty result', () => {
    expect(codeOf(() => pickConversations(all, ['general', 'secret']))).toBe('NOT_FOUND');
  });
});

describe('placeMessages', () => {
  test('the same message from both passes is kept once, the first copy wins', () => {
    const c = conv();
    const seen = new Set<string>();
    placeMessages(c, [msg('1.000100')], seen);
    placeMessages(c, [msg('1.000100', { source: 'search', text: 'other copy' })], seen);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].source).toBe('history');
  });

  test('the same ts in two conversations is two messages', () => {
    const seen = new Set<string>();
    const a = conv('C1');
    const b = conv('C2');
    placeMessages(a, [msg('1.000100')], seen);
    placeMessages(b, [msg('1.000100')], seen);
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
  });

  test('a reply goes under its parent when the parent is here', () => {
    const c = conv();
    const seen = new Set<string>();
    placeMessages(c, [msg('1.000100', { threadTs: '1.000100', replyCount: 1 })], seen);
    placeMessages(c, [msg('2.000100', { threadTs: '1.000100' })], seen);
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0].replies.map((r) => r.ts)).toEqual(['2.000100']);
  });

  test('replies to an absent parent stand alone, each pointing at the same thread', () => {
    const c = conv();
    placeMessages(c, [msg('5.000100', { threadTs: '1.000100' }), msg('6.000100', { threadTs: '1.000100' })], new Set());
    expect(c.messages.map((m) => [m.ts, m.parent?.ts])).toEqual([['5.000100', '1.000100'], ['6.000100', '1.000100']]);
  });

  test('a reply never nests under another orphan reply', () => {
    const c = conv();
    placeMessages(c, [msg('5.000100', { threadTs: '1.000100' }), msg('6.000100', { threadTs: '5.000100' })], new Set());
    expect(c.messages.find((m) => m.ts === '6.000100')?.parent?.ts).toBe('5.000100');
    expect(c.messages.find((m) => m.ts === '5.000100')?.replies).toEqual([]);
  });

  test('a thread parent (threadTs equal to ts) is top-level', () => {
    const c = conv();
    placeMessages(c, [msg('1.000100', { threadTs: '1.000100' })], new Set());
    expect(c.messages[0].parent).toBeUndefined();
  });
});

describe('sortConversation and countMessages', () => {
  test('two messages in the same second keep their order: timestamps compare as strings', () => {
    const c = conv('C1', { messages: [msg('1792454400.000010'), msg('1792454400.000009')] });
    sortConversation(c);
    expect(c.messages.map((m) => m.ts)).toEqual(['1792454400.000009', '1792454400.000010']);
  });

  test('replies to older threads come last, grouped by thread, then by time', () => {
    const c = conv('C1', {
      messages: [
        msg('9.000100', { parent: { ts: '2.000100' } }),
        msg('5.000100'),
        msg('7.000100', { parent: { ts: '1.000100' } }),
        msg('8.000100', { parent: { ts: '2.000100' } }),
        msg('3.000100', { replies: [msg('6.000100'), msg('4.000100')] }),
      ],
    });
    sortConversation(c);
    expect(c.messages.map((m) => m.ts)).toEqual(['3.000100', '5.000100', '7.000100', '8.000100', '9.000100']);
    expect(c.messages[0].replies.map((m) => m.ts)).toEqual(['4.000100', '6.000100']);
    expect(countMessages(c)).toBe(7);
  });
});

describe('resolveNames', () => {
  test('users get their display name, mentions become @name, unknown ids stay raw', () => {
    const c = conv('C1', { messages: [msg('1.1', { user: 'U1', text: 'hi <@U2> and <@U9|old>', replies: [msg('2.1', { user: 'U9' })] })] });
    resolveNames([c], [user('U1', { displayName: 'alice' }), user('U2', { realName: 'Bob B' })]);
    expect(c.messages[0].userName).toBe('alice');
    expect(c.messages[0].text).toBe('hi @Bob B and @U9');
    expect(c.messages[0].replies[0].userName).toBe('U9');
  });

  test('a bot message is named after the bot; a message with neither is "unknown"', () => {
    const c = conv('C1', { messages: [msg('1.1', { botName: 'deploybot' }), msg('2.1')] });
    resolveNames([c], []);
    expect(c.messages.map((m) => m.userName)).toEqual(['deploybot', 'unknown']);
  });

  test('a direct message is named after the other person; an older thread\'s parent gets a name too', () => {
    const c = conv('D1', {
      type: 'dm', user: 'U1', name: 'U1',
      messages: [msg('5.1', { user: 'U1', parent: { ts: '1.1', user: 'U1', text: 'see <@U1>' } })],
    });
    resolveNames([c], [user('U1', { displayName: 'alice' })]);
    expect(c.name).toBe('alice');
    expect(c.messages[0].parent).toEqual({ ts: '1.1', user: 'U1', userName: 'alice', text: 'see @alice' });
  });
});
