import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { OAuth2Client } from 'google-auth-library';
import { GmailClient } from '../../../../src/plugins/google/gmail/client';
import { printDraftResult } from '../../../../src/plugins/google/gmail/output';
import { CliError } from '../../../../src/utils/errors';

const ME = 'me@example.com';

interface Header { name: string; value: string }
interface FakeMessage { id: string; labelIds: string[]; payload: { headers: Header[] } }

function message(id: string, labelIds: string[], headers: Record<string, string>): FakeMessage {
  return { id, labelIds, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } };
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf-8');
}

interface Calls {
  create: any[];
  update: any[];
  get: any[];
}

function makeClient(opts: { draft?: FakeMessage & { threadId: string }; thread?: FakeMessage[]; getError?: Error } = {}) {
  const client = new GmailClient({} as OAuth2Client);
  const calls: Calls = { create: [], update: [], get: [] };
  let counter = 0;
  const respond = (body: any) => ({
    data: { id: 'r-1', message: { id: `msg-${++counter}`, threadId: body.requestBody.message.threadId ?? `new-thread-${counter}` } },
  });
  (client as any).gmail = {
    users: {
      getProfile: async () => ({ data: { emailAddress: ME } }),
      drafts: {
        create: async (body: any) => { calls.create.push(body); return respond(body); },
        update: async (body: any) => { calls.update.push(body); return respond(body); },
        get: async (body: any) => {
          calls.get.push(body);
          if (opts.getError) throw opts.getError;
          return { data: { id: body.id, message: opts.draft } };
        },
      },
      threads: {
        get: async () => ({ data: { messages: opts.thread ?? [] } }),
      },
    },
  };
  return { client, calls };
}

const NOTARY_THREAD = [
  message('m1', ['SENT'], { From: ME, Subject: 'Quote', 'Message-ID': '<a@me>' }),
  message('m2', ['INBOX'], { From: 'notary@example.it', Subject: 'Re: Quote', 'Message-ID': '<b@notary>', References: '<a@me>' }),
  message('d1', ['DRAFT'], { From: ME, Subject: 'Re: Quote', 'Message-ID': '<old-draft@me>', 'In-Reply-To': '<b@notary>' }),
];

describe('GmailClient.updateDraft', () => {
  test('keeps the draft in its current thread when no --reply-to is given', async () => {
    const { client, calls } = makeClient({
      draft: { ...message('msg-0', ['DRAFT'], {}), threadId: 'thread-1' },
    });

    const result = await client.updateDraft('r-1', { to: ['a@example.com'], subject: 'Hello', body: 'v2' });

    expect(calls.get[0]).toMatchObject({ id: 'r-1', format: 'metadata' });
    expect(calls.update[0].requestBody.message.threadId).toBe('thread-1');
    expect(result).toEqual({ id: 'r-1', messageId: 'msg-1', threadId: 'thread-1', account: ME, inConversation: false });
  });

  test('a draft in a thread with sent or received mail is in a conversation', async () => {
    const { client } = makeClient({
      draft: { ...message('d1', ['DRAFT'], {}), threadId: 'thread-1' },
      thread: NOTARY_THREAD,
    });

    const result = await client.updateDraft('r-1', { to: ['notary@example.it'], subject: 'Re: Quote', body: 'v2' });

    expect(result.inConversation).toBe(true);
  });

  test('keeps the threading headers of the message it replaces', async () => {
    const { client, calls } = makeClient({
      draft: {
        ...message('msg-0', ['DRAFT'], { 'In-Reply-To': '<b@notary>', References: '<a@me> <b@notary>' }),
        threadId: 'thread-1',
      },
    });

    await client.updateDraft('r-1', { to: ['notary@example.it'], subject: 'Re: Quote', body: 'v2' });

    const raw = decodeRaw(calls.update[0].requestBody.message.raw);
    expect(raw).toContain('In-Reply-To: <b@notary>\r\n');
    expect(raw).toContain('References: <a@me> <b@notary>\r\n');
  });

  test('with --reply-to, uses that thread and replies to its last real message, not the old draft', async () => {
    const { client, calls } = makeClient({
      draft: { ...message('d1', ['DRAFT'], { 'In-Reply-To': '<stale@me>' }), threadId: 'thread-1' },
      thread: NOTARY_THREAD,
    });

    await client.updateDraft('r-1', { to: [], subject: '', body: 'v2', replyTo: 'thread-1' });

    const raw = decodeRaw(calls.update[0].requestBody.message.raw);
    expect(calls.update[0].requestBody.message.threadId).toBe('thread-1');
    expect(raw).toContain('To: notary@example.it\r\n');
    expect(raw).toContain('In-Reply-To: <b@notary>\r\n');
    expect(raw).toContain('References: <a@me> <b@notary>\r\n');
    expect(raw).not.toContain('stale@me');
    expect(raw).not.toContain('old-draft@me');
  });

  test('reports an unknown draft as NOT_FOUND before replacing anything', async () => {
    const { client, calls } = makeClient({ getError: new Error('Requested entity was not found. (404)') });

    const error = await client.updateDraft('r-x', { to: ['a@example.com'], subject: 'Hello', body: 'v2' }).catch((e) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('NOT_FOUND');
    expect(calls.update).toHaveLength(0);
  });
});

describe('GmailClient reply context', () => {
  test('a reply draft ignores drafts already in the thread', async () => {
    const { client, calls } = makeClient({ thread: NOTARY_THREAD });

    const result = await client.draft({ to: [], subject: '', body: 'Thanks', replyTo: 'thread-1' });

    const raw = decodeRaw(calls.create[0].requestBody.message.raw);
    expect(raw).toContain('Subject: Re: Quote\r\n');
    expect(raw).toContain('In-Reply-To: <b@notary>\r\n');
    expect(raw).toContain('References: <a@me> <b@notary>\r\n');
    expect(result.threadId).toBe('thread-1');
    expect(result.inConversation).toBe(true);
  });

  test('a thread holding only drafts has nothing to reply to', async () => {
    const { client } = makeClient({ thread: [NOTARY_THREAD[2]] });

    const error = await client.draft({ to: [], subject: '', body: 'x', replyTo: 'thread-9' }).catch((e) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('INVALID_PARAMS');
  });

  test('a new draft returns the thread Gmail gave it and the account', async () => {
    const { client } = makeClient();

    const result = await client.draft({ to: ['a@example.com'], subject: 'Hello', body: 'v1' });

    expect(result).toEqual({ id: 'r-1', messageId: 'msg-1', threadId: 'new-thread-1', account: ME, inConversation: false });
  });
});

describe('draft output', () => {
  let logSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => logSpy?.mockRestore());

  const lines = () => logSpy!.mock.calls.map((c: unknown[]) => String(c[0]));

  test('an update prints IDs, the Gmail link and the refresh note', () => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});

    printDraftResult({ id: 'r-2301998990183903913', messageId: 'm2', threadId: '1a1ba38855a04f00', account: ME, inConversation: false }, true);

    expect(lines()).toEqual([
      'Draft updated',
      'Draft ID: r-2301998990183903913',
      'Message ID: m2',
      'Thread ID: 1a1ba38855a04f00',
      'Link: https://mail.google.com/mail/u/?authuser=me%40example.com#drafts?compose=CqMvqmcrdzdNnHRJcfxMwZrNMxHPPQmhKQtJHnvghzqHkNsFSFKXZthDvtVbLVPzZLWsrrLQSfg',
      expect.stringContaining('Close any compose window open on this draft'),
    ]);
  });

  test('a new draft prints no refresh note', () => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});

    printDraftResult({ id: 'r-1', messageId: 'm1', threadId: '1a1b59621b12f33e', account: ME, inConversation: true });

    expect(lines()[0]).toBe('Draft created');
    expect(lines()).toContain('Link: https://mail.google.com/mail/u/?authuser=me%40example.com#drafts/FMfcgzQjgqKPSPRxQdrKkvsFXdjrzDnB');
    expect(lines().some((l: string) => l.startsWith('Note:'))).toBe(false);
  });
});
