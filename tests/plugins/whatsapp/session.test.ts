import { describe, expect, test } from 'bun:test';
import { WhatsAppSession } from '../../../src/plugins/whatsapp/session';
import { CREDS_KEY, MAX_MESSAGES_PER_CHAT } from '../../../src/plugins/whatsapp/records';
import type { ChatSummary, ContactView, ReadResult, SendResult } from '../../../src/plugins/whatsapp/types';
import { FakeBaileys, fakeHost, memoryStore, tick } from '../../helpers/fake-baileys';

const ME = '33600000000:3@s.whatsapp.net';
const ALICE = '33611111111@s.whatsapp.net';
const BOB = '33622222222@s.whatsapp.net';
const GROUP = '120363000@g.us';

/** A store that holds a linked account, as pairing leaves it. */
async function linkedStore() {
  const store = memoryStore();
  await store.set(CREDS_KEY, { me: { id: ME }, noiseKey: 'n', registered: true });
  return store;
}

/** A session started and connected, with its fake socket. */
async function connected(store?: Awaited<ReturnType<typeof linkedStore>>) {
  const api = new FakeBaileys();
  const host = fakeHost(store ?? (await linkedStore()));
  const session = await WhatsAppSession.start(api, host, { backoffMs: 1 });
  api.last.open();
  await tick();
  return { api, host, session, socket: api.last };
}

const call = <T>(session: WhatsAppSession, operation: string, params: Record<string, unknown> = {}, readOnly = false) =>
  session.handle({ operation, params, readOnly }) as Promise<T>;

const incoming = (chat: string, id: string, text: string, at: number, extra: Record<string, unknown> = {}) => ({
  key: { remoteJid: chat, id, fromMe: false, ...extra },
  message: { conversation: text },
  messageTimestamp: at,
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'none';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe('connection', () => {
  test('without a linked account in the store it needs pairing and opens no socket', async () => {
    const api = new FakeBaileys();
    const session = await WhatsAppSession.start(api, fakeHost());
    expect(session.status()).toEqual({ state: 'needs_pairing', detail: 'no linked account in the store' });
    expect(api.sockets).toHaveLength(0);
    expect(await codeOf(call(session, 'send', { to: '+33611111111', text: 'x' }))).toBe('AUTH_EXPIRED');
  });

  test('blank credentials that never linked also need pairing', async () => {
    const store = memoryStore();
    await store.set(CREDS_KEY, { noiseKey: 'n', registered: false });
    const api = new FakeBaileys();
    expect((await WhatsAppSession.start(api, fakeHost(store))).status().state).toBe('needs_pairing');
    expect(api.sockets).toHaveLength(0);
  });

  test('a linked account connects and reports its number', async () => {
    const { session, socket } = await connected();
    expect(session.status()).toEqual({ state: 'open', account: '+33600000000' });
    expect(socket.resyncs).toBe(1);
  });

  test('every change to the credentials is written to the store', async () => {
    const { host, socket } = await connected();
    socket.auth.creds.signedPreKey = { keyId: 7 };
    socket.emit('creds.update', { signedPreKey: { keyId: 7 } });
    await tick();
    expect((await host.store.get<any>(CREDS_KEY)).signedPreKey).toEqual({ keyId: 7 });
  });

  test('Signal keys are stored, read back, and deleted when Baileys clears them', async () => {
    const { host, socket } = await connected();
    await socket.auth.keys.set({ 'pre-key': { '1': { public: 'p' }, '2': { public: 'q' } }, 'app-state-sync-key': { k: { keyData: 'd' } } });
    expect(await socket.auth.keys.get('pre-key', ['1', '2', '3'])).toEqual({ '1': { public: 'p' }, '2': { public: 'q' } });
    // App-state keys go back to Baileys as its own objects.
    expect(await socket.auth.keys.get('app-state-sync-key', ['k'])).toEqual({ k: { proto: { keyData: 'd' } } });
    await socket.auth.keys.set({ 'pre-key': { '1': null } });
    expect(await socket.auth.keys.get('pre-key', ['1'])).toEqual({});
    expect(await host.store.list('auth:key:pre-key:')).toHaveLength(1);
  });

  test('a dropped connection reconnects with a delay that grows', async () => {
    const { api, session, host } = await connected();
    api.last.close(500);
    expect(session.status()).toMatchObject({ state: 'connecting', detail: expect.stringContaining('reconnecting') });
    await tick(10);
    expect(api.sockets).toHaveLength(2);
    api.last.close(428);
    await tick(10);
    expect(api.sockets).toHaveLength(3);
    const delays = host.logs.filter((l) => l.outcome === 'reconnecting').map((l) => l.delay_ms);
    expect(delays).toEqual([1, 2]);
    api.last.open();
    api.last.close(500);
    // A connection that opened resets the delay.
    expect(host.logs.filter((l) => l.outcome === 'reconnecting').at(-1)!.delay_ms).toBe(1);
  });

  test('a restart WhatsApp asks for reconnects at once', async () => {
    const { api } = await connected();
    api.last.close(515);
    expect(api.sockets).toHaveLength(2);
  });

  test('a replaced connection stops reconnecting instead of fighting the other client', async () => {
    const { api, session } = await connected();
    api.last.close(440);
    await tick(20);
    expect(api.sockets).toHaveLength(1);
    expect(session.status()).toMatchObject({ state: 'replaced' });
    expect(await codeOf(call(session, 'send', { to: ALICE, text: 'x' }))).toBe('API_ERROR');
  });

  test('a logged-out device needs pairing, forgets its credentials, and stays that way after a restart', async () => {
    const store = await linkedStore();
    const { api, session } = await connected(store);
    api.last.close(401);
    await tick(20);
    expect(api.sockets).toHaveLength(1);
    expect(session.status()).toMatchObject({ state: 'needs_pairing' });
    expect(await store.get(CREDS_KEY)).toBeUndefined();
    const again = new FakeBaileys();
    expect((await WhatsAppSession.start(again, fakeHost(store))).status().state).toBe('needs_pairing');
    expect(again.sockets).toHaveLength(0);
  });

  test('a refused connection does not retry', async () => {
    const { api, session } = await connected();
    api.last.close(403);
    await tick(20);
    expect(api.sockets).toHaveLength(1);
    expect(session.status()).toMatchObject({ state: 'closed', detail: expect.stringContaining('banned') });
  });

  test('events from a socket that was replaced by a reconnection are ignored', async () => {
    const { api, host } = await connected();
    const old = api.last;
    api.last.close(515);
    old.emit('messages.upsert', { type: 'notify', messages: [incoming(ALICE, 'late', 'ghost', 1)] });
    old.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 440 } } } });
    await tick();
    expect(await host.store.get(`msgs:${ALICE}`)).toBeUndefined();
    expect(api.sockets).toHaveLength(2);
  });

  test('stopping waits for pending writes and does not reconnect', async () => {
    const { api, host, session } = await connected();
    api.last.emit('messages.upsert', { type: 'notify', messages: Array.from({ length: 30 }, (_, i) => incoming(ALICE, `m${i}`, `n${i}`, 100 + i)) });
    await session.stop();
    expect(((await host.store.get<unknown[]>(`msgs:${ALICE}`)) ?? []).length).toBe(30);
    expect(api.last.ended).toBe(true);
    expect(api.last.loggedOut).toBe(false);
    api.last.close(500);
    await tick(10);
    expect(api.sockets).toHaveLength(1);
    expect(session.status().state).toBe('closed');
  });

  test('a removal logs the device out first; a session that is not open is only closed', async () => {
    const { api, session } = await connected();
    await session.stop({ logout: true });
    expect(api.last.loggedOut).toBe(true);

    const other = await connected();
    other.api.last.close(500);
    await other.session.stop({ logout: true });
    expect(other.api.sockets[0]!.loggedOut).toBe(false);
  });
});

describe('what arrives from WhatsApp', () => {
  test('a live message is stored, counted as unread, and names its sender', async () => {
    const { socket, session } = await connected();
    socket.emit('messages.upsert', { type: 'notify', messages: [{ ...incoming(ALICE, 'a1', 'hello', 1000), pushName: 'Ali' }] });
    await tick();
    expect(await call<ChatSummary[]>(session, 'conversations')).toEqual([
      { id: ALICE, name: 'Ali', phone: '+33611111111', isGroup: false, lastMessage: 'hello', lastMessageAt: 1000, unread: 1 },
    ]);
    expect(await call<ContactView[]>(session, 'contacts')).toEqual([{ name: 'Ali', jid: ALICE, phone: '+33611111111', source: 'self' }]);
  });

  test('my own messages, sent from the phone, are stored but never unread', async () => {
    const { socket, session } = await connected();
    socket.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: ALICE, id: 'me1', fromMe: true }, message: { conversation: 'mine' }, messageTimestamp: 5 }] });
    await tick();
    expect((await call<ChatSummary[]>(session, 'conversations'))[0]).toMatchObject({ lastMessage: 'mine', unread: 0 });
  });

  test('media is a placeholder, reactions and status updates are not stored', async () => {
    const { socket, session, host } = await connected();
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: ALICE, id: 'img', fromMe: false }, message: { imageMessage: { caption: 'cat', jpegThumbnail: 'AAAA' } }, messageTimestamp: 1 },
        { key: { remoteJid: ALICE, id: 'r', fromMe: false }, message: { reactionMessage: { text: '👍' } }, messageTimestamp: 2 },
        incoming('status@broadcast', 's', 'story', 3),
      ],
    });
    await tick();
    const read = await call<ReadResult>(session, 'read', { chat: ALICE, receipts: false });
    expect(read.messages.map((m) => m.text)).toEqual(['[image] cat']);
    expect(await host.store.get('chat:status@broadcast')).toBeUndefined();
    expect([...(host.store as ReturnType<typeof memoryStore>).data.values()].join('')).not.toContain('AAAA');
  });

  test('a chat keeps its most recent messages only, and a repeated message once', async () => {
    const { socket, session } = await connected();
    const many = Array.from({ length: MAX_MESSAGES_PER_CHAT + 5 }, (_, i) => incoming(ALICE, `m${i}`, `n${i}`, 1000 + i));
    socket.emit('messages.upsert', { type: 'append', messages: [...many, many[many.length - 1]] });
    await tick(20);
    const read = await call<ReadResult>(session, 'read', { chat: ALICE, last: 500, receipts: false });
    expect(read.messages).toHaveLength(MAX_MESSAGES_PER_CHAT);
    expect(read.messages[0]!.text).toBe('n5');
    expect(read.messages.at(-1)!.text).toBe(`n${MAX_MESSAGES_PER_CHAT + 4}`);
  });

  test('history sync fills the chat index, names and messages, without counting them as new', async () => {
    const { socket, session } = await connected();
    socket.emit('messaging-history.set', {
      chats: [
        { id: ALICE, unreadCount: 2, conversationTimestamp: 50 },
        { id: GROUP, name: 'Climbing', conversationTimestamp: 60 },
      ],
      contacts: [{ id: ALICE, name: 'Alice Martin', notify: 'Ali' }],
      messages: [incoming(ALICE, 'h1', 'old news', 50)],
      isLatest: true,
    });
    await tick();
    const chats = await call<ChatSummary[]>(session, 'conversations');
    expect(chats.map((c) => [c.id, c.name, c.unread])).toEqual([[GROUP, 'Climbing', 0], [ALICE, 'Alice Martin', 2]]);
    expect((await call<ContactView[]>(session, 'contacts', { query: 'alice' }))).toEqual([
      { name: 'Alice Martin', jid: ALICE, phone: '+33611111111', source: 'contact' },
    ]);
  });

  test('groups are fetched when the connection opens and join the conversations', async () => {
    const api = new FakeBaileys();
    api.groups = { [GROUP]: { id: GROUP, subject: 'Climbing' } };
    const session = await WhatsAppSession.start(api, fakeHost(await linkedStore()));
    api.last.open();
    await tick();
    expect(await call<ChatSummary[]>(session, 'conversations')).toEqual([{ id: GROUP, name: 'Climbing', isGroup: true, unread: 0 }]);
    expect(await call<ContactView[]>(session, 'contacts')).toEqual([{ name: 'Climbing', jid: GROUP, source: 'group' }]);
  });

  test('a chat read on the phone stops being unread here', async () => {
    const { socket, session } = await connected();
    socket.emit('messages.upsert', { type: 'notify', messages: [incoming(ALICE, 'a1', 'hi', 10)] });
    socket.emit('chats.update', [{ id: ALICE, unreadCount: 0 }]);
    await tick();
    expect((await call<ChatSummary[]>(session, 'conversations', { unreadOnly: true }))).toEqual([]);
  });

  test('a hidden ID is shown by name and ID, then filed under the number once it is learned', async () => {
    const { socket, session } = await connected();
    socket.emit('messages.upsert', { type: 'notify', messages: [{ ...incoming('777@lid', 'l1', 'psst', 10), pushName: 'Harry' }] });
    await tick();
    expect(await call<ChatSummary[]>(session, 'conversations')).toEqual([
      { id: '777@lid', name: 'Harry', isGroup: false, lastMessage: 'psst', lastMessageAt: 10, unread: 1 },
    ]);
    expect(await call<ContactView[]>(session, 'contacts')).toEqual([{ name: 'Harry', jid: '777@lid', source: 'self' }]);

    socket.emit('lid-mapping.update', { lid: '777@lid', pn: BOB });
    socket.emit('messages.upsert', { type: 'notify', messages: [incoming(BOB, 'b1', 'it is me', 20)] });
    await tick();
    const chats = await call<ChatSummary[]>(session, 'conversations');
    expect(chats).toEqual([{ id: BOB, name: 'Harry', phone: '+33622222222', isGroup: false, lastMessage: 'it is me', lastMessageAt: 20, unread: 2 }]);
    const read = await call<ReadResult>(session, 'read', { chat: '+33622222222', receipts: false });
    expect(read.messages.map((m) => [m.text, m.sender])).toEqual([['psst', BOB], ['it is me', BOB]]);
  });

  test('a message that carries both IDs files the chat under the number', async () => {
    const { socket, session } = await connected();
    socket.emit('messages.upsert', { type: 'notify', messages: [incoming('888@lid', 'x1', 'hey', 10, { remoteJidAlt: ALICE })] });
    await tick();
    expect((await call<ChatSummary[]>(session, 'conversations')).map((c) => c.id)).toEqual([ALICE]);
  });

  test('in a group, the sender is the member, and their name is learned', async () => {
    const { socket, session } = await connected();
    socket.emit('messages.upsert', { type: 'notify', messages: [{ ...incoming(GROUP, 'g1', 'on my way', 10, { participant: BOB }), pushName: 'Bobby' }] });
    await tick();
    const read = await call<ReadResult>(session, 'read', { chat: GROUP, receipts: false });
    expect(read.messages).toEqual([{ id: 'g1', fromMe: false, sender: BOB, senderName: 'Bobby', text: 'on my way', at: 10 }]);
    expect((await call<ContactView[]>(session, 'contacts', { query: 'bobby' }))[0]).toMatchObject({ jid: BOB, source: 'self' });
  });
});

describe('operations', () => {
  async function withChats() {
    const setup = await connected();
    setup.socket.emit('contacts.upsert', [
      { id: ALICE, name: 'Alice' },
      { id: BOB, name: 'Bob' },
      { id: '33633333333@s.whatsapp.net', name: 'Bob' },
      { id: '555@lid', notify: 'Ghost' },
    ]);
    setup.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [incoming(ALICE, 'a1', 'one', 10), incoming(ALICE, 'a2', 'two', 20), incoming(BOB, 'b1', 'hey', 15)],
    });
    await tick();
    return setup;
  }

  test('conversations are newest first, limited, and filtered to unread', async () => {
    const { session, socket } = await withChats();
    expect((await call<ChatSummary[]>(session, 'conversations')).map((c) => c.id)).toEqual([ALICE, BOB]);
    expect((await call<ChatSummary[]>(session, 'conversations', { limit: 1 })).map((c) => c.id)).toEqual([ALICE]);
    socket.emit('chats.update', [{ id: BOB, unreadCount: 0 }]);
    await tick();
    expect((await call<ChatSummary[]>(session, 'conversations', { unreadOnly: true })).map((c) => c.id)).toEqual([ALICE]);
  });

  test.each([0, -1, 1.5, 501, '5', null])('a limit of %p is refused', async (limit) => {
    const { session } = await withChats();
    expect(await codeOf(call(session, 'conversations', { limit }))).toBe('INVALID_PARAMS');
    expect(await codeOf(call(session, 'read', { chat: ALICE, last: limit }))).toBe('INVALID_PARAMS');
  });

  test('sending to a number checks WhatsApp first, then stores what was sent', async () => {
    const { session, socket } = await withChats();
    socket.registered.set('33644444444', '33644444444@s.whatsapp.net');
    const result = await call<SendResult>(session, 'send', { to: '+33 6 44 44 44 44', text: 'Hello' });
    expect(result).toEqual({ id: 'SENT1', to: '33644444444@s.whatsapp.net', timestamp: 1_800_000_001 });
    expect(socket.sent).toEqual([{ jid: '33644444444@s.whatsapp.net', text: 'Hello' }]);
    const read = await call<ReadResult>(session, 'read', { chat: '+33644444444', receipts: false });
    expect(read.messages).toMatchObject([{ id: 'SENT1', fromMe: true, text: 'Hello' }]);
    // WhatsApp may ask for a sent message again to retry its delivery.
    expect(await socket.getMessage({ id: 'SENT1' })).toEqual({ conversation: 'Hello' });
  });

  test('a number that is not on WhatsApp fails before anything is sent', async () => {
    const { session, socket } = await withChats();
    const error = await call(session, 'send', { to: '+33699999999', text: 'x' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: '+33699999999 is not on WhatsApp' });
    expect(socket.sent).toEqual([]);
  });

  test('a name sends to the one person it names', async () => {
    const { session, socket } = await withChats();
    expect(await call<SendResult>(session, 'send', { to: 'alice', text: 'hi' })).toMatchObject({ to: ALICE, toName: 'Alice' });
    expect(socket.sent).toEqual([{ jid: ALICE, text: 'hi' }]);
  });

  test('an ambiguous or unknown name fails, saying why, and sends nothing', async () => {
    const { session, socket } = await withChats();
    const ambiguous = await call(session, 'send', { to: 'Bob', text: 'hi' }).catch((e) => e);
    expect(ambiguous).toMatchObject({ code: 'INVALID_PARAMS', message: expect.stringContaining('+33633333333') });
    const unknown = await call(session, 'send', { to: 'Carol', text: 'hi' }).catch((e) => e);
    expect(unknown).toMatchObject({ code: 'NOT_FOUND', suggestion: expect.stringContaining('phone number') });
    expect(socket.sent).toEqual([]);
  });

  test('a recipient known only by a hidden ID is sent to by that ID', async () => {
    const { session, socket } = await withChats();
    expect(await call<SendResult>(session, 'send', { to: 'Ghost', text: 'boo' })).toMatchObject({ to: '555@lid', toName: 'Ghost' });
    expect(socket.sent).toEqual([{ jid: '555@lid', text: 'boo' }]);
  });

  test('a read-only profile cannot send, even if the daemon\'s check were bypassed', async () => {
    const { session, socket } = await withChats();
    expect(await codeOf(call(session, 'send', { to: ALICE, text: 'x' }, true))).toBe('PERMISSION_DENIED');
    expect(socket.sent).toEqual([]);
  });

  test.each([{}, { to: ALICE }, { to: ALICE, text: '' }, { to: ALICE, text: '   ' }, { to: 5, text: 'x' }, { to: ALICE, text: 'x'.repeat(70_000) }])(
    'send refuses %j', async (params) => {
      const { session, socket } = await withChats();
      expect(await codeOf(call(session, 'send', params))).toBe('INVALID_PARAMS');
      expect(socket.sent).toEqual([]);
    },
  );

  test('sending while disconnected fails clearly', async () => {
    const { session, api } = await withChats();
    api.last.close(500);
    expect(await codeOf(call(session, 'send', { to: ALICE, text: 'x' }))).toBe('API_ERROR');
  });

  test('reading returns the last messages and marks the incoming ones as read', async () => {
    const { session, socket } = await withChats();
    const read = await call<ReadResult>(session, 'read', { chat: 'Alice', last: 1 });
    expect(read.messages.map((m) => m.text)).toEqual(['two']);
    expect(read.receiptsSent).toBe(1);
    expect(socket.receipts).toEqual([[{ remoteJid: ALICE, id: 'a2', fromMe: false }]]);
    expect(read.chat.unread).toBe(0);
    await tick();
    expect((await call<ChatSummary[]>(session, 'conversations', { unreadOnly: true })).map((c) => c.id)).toEqual([BOB]);
  });

  test('a group\'s read receipts name the member who wrote', async () => {
    const { session, socket } = await connected();
    socket.emit('messages.upsert', { type: 'notify', messages: [incoming(GROUP, 'g1', 'yo', 10, { participant: BOB })] });
    await tick();
    await call(session, 'read', { chat: GROUP });
    expect(socket.receipts).toEqual([[{ remoteJid: GROUP, id: 'g1', fromMe: false, participant: BOB }]]);
  });

  test('without receipts, nothing is marked as read and the chat stays unread', async () => {
    const { session, socket } = await withChats();
    const read = await call<ReadResult>(session, 'read', { chat: ALICE, receipts: false });
    expect(read.receiptsSent).toBe(0);
    expect(socket.receipts).toEqual([]);
    expect(read.chat.unread).toBe(2);
  });

  test('a read-only profile never sends receipts, whatever it asks for', async () => {
    const { session, socket } = await withChats();
    const read = await call<ReadResult>(session, 'read', { chat: ALICE, receipts: true }, true);
    expect(read.receiptsSent).toBe(0);
    expect(socket.receipts).toEqual([]);
  });

  test('reading while disconnected still answers from the store, unmarked', async () => {
    const { session, api } = await withChats();
    api.last.close(500);
    const read = await call<ReadResult>(session, 'read', { chat: ALICE });
    expect(read.messages).toHaveLength(2);
    expect(read.receiptsSent).toBe(0);
  });

  test('reading a chat nobody wrote in is empty, not an error', async () => {
    const { session } = await withChats();
    const read = await call<ReadResult>(session, 'read', { chat: '+33677777777' });
    expect(read).toEqual({ chat: { id: '33677777777@s.whatsapp.net', phone: '+33677777777', isGroup: false, unread: 0 }, messages: [], receiptsSent: 0 });
  });

  test('contacts come from the store only, with and without a query', async () => {
    const { session, socket } = await withChats();
    socket.onWhatsApp = async () => { throw new Error('contacts must not ask WhatsApp'); };
    expect((await call<ContactView[]>(session, 'contacts')).map((c) => c.name)).toEqual(['Alice', 'Bob', 'Bob', 'Ghost']);
    expect(await call<ContactView[]>(session, 'contacts', { query: 'gho' })).toEqual([{ name: 'Ghost', jid: '555@lid', source: 'self' }]);
    expect(await codeOf(call(session, 'contacts', { query: 5 }))).toBe('INVALID_PARAMS');
  });

  test('an unknown operation is NOT_FOUND', async () => {
    const { session } = await withChats();
    expect(await codeOf(call(session, 'delete-everything'))).toBe('NOT_FOUND');
  });

  test('after a restart, conversations and messages come back from the store before any connection', async () => {
    const store = await linkedStore();
    const first = await connected(store);
    first.socket.emit('messages.upsert', { type: 'notify', messages: [incoming(ALICE, 'a1', 'kept', 10)] });
    await first.session.stop();

    const api = new FakeBaileys();
    const again = await WhatsAppSession.start(api, fakeHost(store));
    expect(again.status().state).toBe('connecting');
    expect((await call<ChatSummary[]>(again, 'conversations')).map((c) => [c.id, c.lastMessage, c.unread])).toEqual([[ALICE, 'kept', 1]]);
    expect((await call<ReadResult>(again, 'read', { chat: ALICE })).messages.map((m) => m.text)).toEqual(['kept']);
  });
});
