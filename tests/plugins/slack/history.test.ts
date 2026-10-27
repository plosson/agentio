import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { searchQuery, SlackApiError, SlackClient, slackTs, threadTsFromPermalink } from '../../../src/plugins/slack/client';
import { caught, FakeSlack, fakeChannel, TOKEN, tsAt } from './fake-slack';

let fake: FakeSlack;
let client: SlackClient;

beforeEach(() => {
  fake = new FakeSlack();
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
});

afterEach(() => fake.stop());

const range = (since: string, until: string) => ({ since: new Date(since), until: new Date(until) });
const methods = () => fake.log.map((c) => c.url.replace('https://slack.com/api/', ''));
const general = () => fake.channels.find((c) => c.id === 'C0GENERAL')!;

describe('slackTs and searchQuery', () => {
  test('slackTs keeps the milliseconds, with six decimals', () => {
    expect(slackTs(new Date('2026-10-20T00:00:00.123Z'))).toBe('1792454400.123000');
  });

  test('search dates are widened by two days each side, whatever the time of day', () => {
    expect(searchQuery(range('2026-10-20T10:00:00Z', '2026-10-27T08:00:00Z'))).toBe('after:2026-10-18 before:2026-10-29');
    expect(searchQuery(range('2026-10-20T00:00:00Z', '2026-10-20T23:59:59Z'))).toBe('after:2026-10-18 before:2026-10-22');
  });
});

describe('threadTsFromPermalink', () => {
  test('a reply permalink gives its thread_ts', () => {
    expect(threadTsFromPermalink('https://x.slack.com/archives/C1/p1700000000000200?thread_ts=1700000000.000100&cid=C1')).toBe('1700000000.000100');
  });

  test('no query, garbage, a malformed thread_ts or no permalink at all give undefined, never a throw', () => {
    for (const bad of [
      'https://x.slack.com/archives/C1/p1700000000000200',
      '::not a url',
      'https://x.slack.com/archives/C1/p1?thread_ts=abc',
      'https://x.slack.com/archives/C1/p1?thread_ts=1700000000.000100x',
      'https://x.slack.com/archives/C1/p1?thread_ts=',
      undefined,
      42,
    ]) {
      expect(threadTsFromPermalink(bad)).toBeUndefined();
    }
  });
});

describe('listMyConversations', () => {
  test('only conversations you are in, of every kind, with a DM keeping its other person', async () => {
    fake.channels.push(
      fakeChannel('C0OTHER', 'other', { members: ['U0001'] }),
      fakeChannel('G0TEAM', 'team', { is_private: true }),
      fakeChannel('D0BOB', '', { is_im: true, user: 'U0001', members: ['U0ADMIN', 'U0001'] }),
      fakeChannel('G0MPDM', 'mpdm-admin--u0001--u0002-1', { is_mpim: true, members: ['U0ADMIN', 'U0001', 'U0002'] }),
    );
    const listed = await client.listMyConversations(['channel', 'private', 'dm', 'group']);
    expect(listed.map((c) => [c.id, c.type])).toEqual([
      ['C0GENERAL', 'channel'], ['C0RANDOM', 'channel'], ['G0TEAM', 'private'], ['D0BOB', 'dm'], ['G0MPDM', 'group'],
    ]);
    expect(listed.find((c) => c.id === 'D0BOB')).toEqual({ id: 'D0BOB', name: 'U0001', type: 'dm', user: 'U0001' });
    expect(fake.log[0].params.types).toBe('public_channel,private_channel,im,mpim');
    expect(fake.log[0].params.exclude_archived).toBe('true');
  });

  test('every page is read', async () => {
    fake.channelPageSize = 1;
    expect(await client.listMyConversations(['channel'])).toHaveLength(2);
    expect(methods()).toEqual(['users.conversations', 'users.conversations']);
  });

  test('a missing im:read fails naming it, as a SlackApiError carrying Slack\'s code', async () => {
    fake.scopes.delete('im:read');
    const err = await caught(client.listMyConversations(['dm']));
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe('PERMISSION_DENIED');
    expect((err as SlackApiError).slackError).toBe('missing_scope');
    expect(err.message).toContain('im:read');
  });
});

describe('history', () => {
  test('both ends are inclusive, oldest first, a second outside is not', async () => {
    general().messages.push(
      { ts: tsAt('2026-10-19T23:59:59Z'), user: 'U0001', text: 'before' },
      { ts: tsAt('2026-10-20T00:00:00Z'), user: 'U0001', text: 'first' },
      { ts: tsAt('2026-10-27T00:00:00Z', 0), user: 'U0001', text: 'last' },
      { ts: tsAt('2026-10-27T00:00:01Z'), user: 'U0001', text: 'after' },
    );
    const got = await client.history('C0GENERAL', range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'));
    expect(got.map((m) => m.text)).toEqual(['first', 'last']);
    expect(got[0]).toMatchObject({ user: 'U0001', source: 'history', replyCount: 0, files: [], replies: [] });
  });

  test('thread replies stay out, a reply also sent to the channel stays in', async () => {
    const parent = tsAt('2026-10-21T09:00:00Z');
    general().messages.push(
      { ts: parent, user: 'U0001', text: 'parent' },
      { ts: tsAt('2026-10-21T09:01:00Z'), user: 'U0002', text: 'hidden reply', thread_ts: parent },
      { ts: tsAt('2026-10-21T09:02:00Z'), user: 'U0002', text: 'broadcast', thread_ts: parent, subtype: 'thread_broadcast' },
    );
    const got = await client.history('C0GENERAL', range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'));
    expect(got.map((m) => m.text)).toEqual(['parent', 'broadcast']);
    expect(got[0]).toMatchObject({ threadTs: parent, replyCount: 2 });
  });

  test('a bot message keeps the bot name; files keep their names', async () => {
    general().messages.push({ ts: tsAt('2026-10-21T09:00:00Z'), username: 'deploybot', subtype: 'bot_message', text: 'done', files: [{ name: 'log.txt' }] });
    const [m] = await client.history('C0GENERAL', range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'));
    expect(m.user).toBeUndefined();
    expect(m.botName).toBe('deploybot');
    expect(m.files).toEqual(['log.txt']);
  });

  test('a 429 between pages retries the same cursor: no duplicates, no gaps', async () => {
    fake.channelPageSize = 1;
    for (let i = 1; i <= 3; i++) general().messages.push({ ts: tsAt(`2026-10-2${i}T09:00:00Z`), user: 'U0001', text: `m${i}` });
    fake.queueAt(2, { status: 429, headers: { 'Retry-After': '1' } });
    const got = await client.history('C0GENERAL', range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'));
    expect(got.map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);
    expect(fake.log[2].params.cursor).toBe(fake.log[1].params.cursor);
  });

  test('channel_not_found keeps Slack\'s code for the caller to decide', async () => {
    fake.historyErrors.C0GENERAL = 'channel_not_found';
    const err = await caught(client.history('C0GENERAL', range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z')));
    expect(err.code).toBe('NOT_FOUND');
    expect((err as SlackApiError).slackError).toBe('channel_not_found');
  });
});

describe('replies and threadParent', () => {
  const parent = tsAt('2026-10-15T09:00:00Z');

  beforeEach(() => {
    general().messages.push({ ts: parent, user: 'U0001', text: 'logo v2' });
    for (let i = 1; i <= 3; i++) general().messages.push({ ts: tsAt('2026-10-22T09:00:00Z', i), user: 'U0002', text: `r${i}`, thread_ts: parent });
  });

  test('a thread over several pages gives every reply once, oldest first, without the parent', async () => {
    fake.channelPageSize = 1;
    const got = await client.replies('C0GENERAL', parent);
    expect(got.map((m) => m.text)).toEqual(['r1', 'r2', 'r3']);
    expect(got.every((m) => m.threadTs === parent)).toBe(true);
  });

  test('threadParent reads one message only', async () => {
    const got = await client.threadParent('C0GENERAL', parent);
    expect(got?.text).toBe('logo v2');
    expect(fake.log.at(-1)!.params.limit).toBe('1');
  });

  test('a deleted parent is thread_not_found, kept as Slack\'s code', async () => {
    const err = await caught(client.threadParent('C0GENERAL', tsAt('2026-10-01T00:00:00Z')));
    expect(err.code).toBe('NOT_FOUND');
    expect((err as SlackApiError).slackError).toBe('thread_not_found');
  });
});

describe('searchMessages', () => {
  const window = range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z');

  test('sends the widened query, oldest first, and reads thread_ts from each permalink', async () => {
    const parent = tsAt('2026-10-15T09:00:00Z');
    general().messages.push(
      { ts: parent, user: 'U0001', text: 'logo v2' },
      { ts: tsAt('2026-10-22T09:00:00Z'), user: 'U0002', text: 'late reply', thread_ts: parent },
      { ts: tsAt('2026-10-23T09:00:00Z'), user: 'U0001', text: 'top level' },
    );
    const { matches: got } = await client.searchMessages(window);
    expect(fake.log[0].params).toMatchObject({ query: 'after:2026-10-18 before:2026-10-29', sort: 'timestamp', sort_dir: 'asc' });
    expect(got.map((m) => [m.channelId, m.message.text, m.message.threadTs, m.message.source])).toEqual([
      ['C0GENERAL', 'late reply', parent, 'search'],
      ['C0GENERAL', 'top level', undefined, 'search'],
    ]);
  });

  test('every page is read', async () => {
    fake.searchPageSize = 1;
    for (let i = 1; i <= 3; i++) general().messages.push({ ts: tsAt(`2026-10-2${i}T09:00:00Z`), user: 'U0001', text: `m${i}` });
    expect((await client.searchMessages(window)).matches).toHaveLength(3);
    expect(fake.log.map((c) => c.params.page)).toEqual(['1', '2', '3']);
  });

  test('matches without a ts or channel are dropped; a broken permalink is a top-level message', async () => {
    fake.searchMatches = [
      { ts: '1792454500.000100', text: 'ok', user: 'U0001', channel: { id: 'C0GENERAL' }, permalink: '::bad' },
      { text: 'no ts', channel: { id: 'C0GENERAL' } },
      { ts: '1792454600.000100', text: 'no channel' },
      { ts: '1792454700.000100', text: 'empty channel', channel: {} },
    ];
    const { matches: got } = await client.searchMessages(window);
    expect(got).toHaveLength(1);
    expect(got[0].message.threadTs).toBeUndefined();
  });

  test('a missing search:read fails naming it', async () => {
    fake.scopes.delete('search:read');
    const err = await caught(client.searchMessages(window));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('search:read');
  });
});

describe('searchMessages truncation', () => {
  test('past 100 pages, the result says it was cut', async () => {
    fake.searchPageSize = 1;
    fake.searchMatches = Array.from({ length: 101 }, (_, i) => ({ ts: `1792540800.${String(i + 1).padStart(6, '0')}`, text: 'x', channel: { id: 'C0GENERAL' } }));
    const got = await client.searchMessages(range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'));
    expect(got.matches).toHaveLength(100);
    expect(got.truncated).toBe(true);
  });

  test('a result that fits is not marked as cut', async () => {
    const got = await client.searchMessages(range('2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z'));
    expect(got.truncated).toBe(false);
  });
});
