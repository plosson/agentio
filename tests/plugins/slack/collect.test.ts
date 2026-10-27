import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SlackClient } from '../../../src/plugins/slack/client';
import { collectMessages } from '../../../src/plugins/slack/messages';
import { printSlackMessages } from '../../../src/plugins/slack/output';
import { caught, FakeSlack, fakeChannel, rawUser, TOKEN, tsAt } from './fake-slack';

let fake: FakeSlack;
let client: SlackClient;
let warnings: string[];

beforeEach(() => {
  fake = new FakeSlack();
  fake.users = [rawUser('U0001', { profile: { display_name: 'alice' } }), rawUser('U0002', { profile: { display_name: 'bob' } })];
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
  warnings = [];
});

afterEach(() => fake.stop());

const range = { since: new Date('2026-10-20T00:00:00Z'), until: new Date('2026-10-27T00:00:00Z') };
const collect = (extra: Record<string, unknown> = {}) => collectMessages(client, { range, onWarning: (m) => warnings.push(m), ...extra });
const methods = () => fake.log.map((c) => c.url.replace('https://slack.com/api/', ''));
const channel = (id: string) => fake.channels.find((c) => c.id === id)!;

describe('collectMessages, history pass', () => {
  test('messages and in-range thread replies, grouped by conversation, busiest first, names resolved', async () => {
    const parent = tsAt('2026-10-21T09:00:00Z');
    channel('C0GENERAL').messages.push(
      { ts: parent, user: 'U0001', text: 'deploy is green' },
      { ts: tsAt('2026-10-21T09:05:00Z'), user: 'U0002', text: 'thanks <@U0001>', thread_ts: parent },
      { ts: tsAt('2026-10-28T09:00:00Z'), user: 'U0002', text: 'after until', thread_ts: parent },
    );
    channel('C0RANDOM').messages.push(
      { ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0002', text: 'lunch?' },
      { ts: tsAt('2026-10-22T10:01:00Z'), user: 'U0001', text: 'yes' },
      { ts: tsAt('2026-10-22T10:02:00Z'), user: 'U0002', text: 'ok' },
    );
    fake.scopes.delete('search:read');
    const result = await collect();
    expect(result.conversations.map((c) => c.name)).toEqual(['random', 'general']);
    const general = result.conversations[1];
    expect(general.messages).toHaveLength(1);
    expect(general.messages[0]).toMatchObject({ userName: 'alice', text: 'deploy is green' });
    expect(general.messages[0].replies.map((r) => [r.userName, r.text])).toEqual([['bob', 'thanks @alice']]);
    expect(result.since).toBe('2026-10-20T00:00:00.000Z');
  });

  test('a conversation with nothing in range is left out, and with no messages at all users.list is never called', async () => {
    fake.scopes.delete('search:read');
    const result = await collect();
    expect(result.conversations).toEqual([]);
    expect(methods()).not.toContain('users.list');
  });

  test('a bot message shows the bot name, not undefined', async () => {
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-21T09:00:00Z'), username: 'deploybot', subtype: 'bot_message', text: 'v3.31 out' });
    fake.scopes.delete('search:read');
    const [conv] = (await collect()).conversations;
    expect(conv.messages[0].userName).toBe('deploybot');
  });

  test('one conversation gone mid-run is a warning; the others are still read', async () => {
    channel('C0RANDOM').messages.push({ ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0002', text: 'still here' });
    fake.historyErrors.C0GENERAL = 'channel_not_found';
    fake.scopes.delete('search:read');
    const result = await collect();
    expect(result.conversations.map((c) => c.name)).toEqual(['random']);
    expect(warnings.some((w) => w.includes('#general'))).toBe(true);
  });

  test('a missing history scope stops the run instead of returning a partial digest', async () => {
    channel('C0RANDOM').messages.push({ ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0002', text: 'x' });
    fake.scopes.delete('channels:history');
    const err = await caught(collect());
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('channels:history');
  });

  test('--channel you are not in fails before reading any history', async () => {
    fake.channels.push(fakeChannel('C0OTHER', 'other', { members: ['U0001'] }));
    const err = await caught(collect({ channels: ['other'] }));
    expect(err.code).toBe('NOT_FOUND');
    expect(methods()).not.toContain('conversations.history');
  });

  test('a webhook profile is refused without calling Slack', async () => {
    const webhook = new SlackClient({ type: 'webhook', webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    const err = await caught(collectMessages(webhook, { range }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('progress counts every conversation', async () => {
    fake.scopes.delete('search:read');
    const seen: string[] = [];
    await collect({ onProgress: (done: number, total: number) => seen.push(`${done}/${total}`) });
    expect(seen).toEqual(['1/2', '2/2']);
  });
});

describe('printSlackMessages', () => {
  test('text output: header, conversation heading, indented replies, continuation lines indented', () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    try {
      printSlackMessages({
        since: '2026-10-20T00:00:00.000Z', until: '2026-10-27T00:00:00.000Z',
        conversations: [{
          id: 'C1', name: 'eng', type: 'channel',
          messages: [{
            ts: tsAt('2026-10-21T09:12:00Z'), userName: 'alice', text: 'line one\nline two', replyCount: 1, files: ['log.txt'], source: 'history',
            replies: [{ ts: tsAt('2026-10-21T09:13:00Z'), userName: 'bob', text: 'thanks', replyCount: 0, files: [], replies: [], source: 'history' }],
          }],
        }],
      });
    } finally {
      spy.mockRestore();
    }
    const out = lines.join('\n');
    expect(lines[0]).toBe('Slack messages 2026-10-20 → 2026-10-27: 1 conversation, 1 message, 1 reply');
    expect(out).toContain('#eng  (2 messages)');
    expect(out).toContain('alice: line one\n');
    expect(out).toMatch(/\n {13}line two \[file: log\.txt\]/);
    expect(out).toMatch(/ {2}↳ \d\d-\d\d \d\d:\d\d  bob: thanks/);
  });

  test('an empty result prints only the header', () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    try {
      printSlackMessages({ since: '2026-10-20T00:00:00.000Z', until: '2026-10-27T00:00:00.000Z', conversations: [] });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(['Slack messages 2026-10-20 → 2026-10-27: 0 conversations, 0 messages, 0 replies']);
  });
});
describe('collectMessages, search pass', () => {
  const oldParent = tsAt('2026-10-15T09:00:00Z');

  test('replies in a thread that started before --since appear, under a label naming the thread, parent read once', async () => {
    channel('C0GENERAL').messages.push(
      { ts: oldParent, user: 'U0001', text: 'logo v2 for the new site, thoughts please' },
      { ts: tsAt('2026-10-22T14:03:00Z'), user: 'U0002', text: 'looks good to me', thread_ts: oldParent },
      { ts: tsAt('2026-10-23T08:00:00Z'), user: 'U0001', text: 'merged', thread_ts: oldParent },
    );
    const [conv] = (await collect()).conversations;
    expect(conv.messages.map((m) => [m.text, m.source, m.parent?.ts])).toEqual([
      ['looks good to me', 'search', oldParent],
      ['merged', 'search', oldParent],
    ]);
    expect(conv.messages[0].parent).toMatchObject({ userName: 'alice', text: 'logo v2 for the new site, thoughts please' });
    expect(fake.log.filter((c) => c.url.endsWith('conversations.replies') && c.params.limit === '1')).toHaveLength(1);
  });

  test('what both passes find is kept once, from history', async () => {
    const parent = tsAt('2026-10-21T09:00:00Z');
    channel('C0GENERAL').messages.push(
      { ts: parent, user: 'U0001', text: 'p' },
      { ts: tsAt('2026-10-21T09:01:00Z'), user: 'U0002', text: 'r', thread_ts: parent },
    );
    const [conv] = (await collect()).conversations;
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].source).toBe('history');
    expect(conv.messages[0].replies.map((r) => r.source)).toEqual(['history']);
  });

  test('search results from a public channel you are not in are dropped', async () => {
    fake.channels.push(fakeChannel('C0OTHER', 'other', { members: ['U0001'], messages: [{ ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0001', text: 'not yours' }] }));
    const result = await collect();
    expect(JSON.stringify(result)).not.toContain('not yours');
  });

  test('search results inside the two-day widening but outside the exact range are trimmed', async () => {
    channel('C0GENERAL').messages.push(
      { ts: oldParent, user: 'U0001', text: 'p' },
      { ts: tsAt('2026-10-19T23:00:00Z'), user: 'U0002', text: 'an hour early', thread_ts: oldParent },
      { ts: tsAt('2026-10-27T01:00:00Z'), user: 'U0002', text: 'an hour late', thread_ts: oldParent },
    );
    const result = await collect();
    expect(result.conversations).toEqual([]);
  });

  test('a deleted parent leaves its replies in, labelled as no longer available', async () => {
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-22T14:03:00Z'), user: 'U0002', text: 'orphan', thread_ts: oldParent });
    const result = await collect();
    const [conv] = result.conversations;
    expect(conv.messages[0].parent).toEqual({ ts: oldParent });
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    try {
      printSlackMessages(result);
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('\n')).toContain('thread by unknown: (no longer available)');
  });

  test('without search:read the history pass still prints, with a warning; a broadcast reply to an older thread survives', async () => {
    fake.scopes.delete('search:read');
    channel('C0GENERAL').messages.push(
      { ts: oldParent, user: 'U0001', text: 'p' },
      { ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0002', text: 'also to channel', thread_ts: oldParent, subtype: 'thread_broadcast' },
    );
    const [conv] = (await collect()).conversations;
    expect(conv.messages.map((m) => [m.text, m.parent?.text])).toEqual([['also to channel', 'p']]);
    expect(warnings.some((w) => w.includes('search:read') && w.includes('may be missing'))).toBe(true);
  });

  test('search rate-limited past every retry is a warning, not a failure', async () => {
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0001', text: 'kept' });
    // Calls: users.conversations, history x2, then search plus its 3 retries.
    for (let call = 4; call <= 7; call++) fake.queueAt(call, { status: 429, headers: { 'Retry-After': '1' } });
    const [conv] = (await collect()).conversations;
    expect(conv.messages[0].text).toBe('kept');
    expect(warnings.some((w) => w.includes('may be missing'))).toBe(true);
  });

  test('--channel limits search results to the picked conversations', async () => {
    channel('C0RANDOM').messages.push({ ts: oldParent, user: 'U0001', text: 'p' }, { ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0002', text: 'in random', thread_ts: oldParent });
    const result = await collect({ channels: ['general'] });
    expect(JSON.stringify(result)).not.toContain('in random');
  });
});
