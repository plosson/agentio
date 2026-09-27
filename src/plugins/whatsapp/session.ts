import { CliError } from '../../utils/errors';
import type { Pairing, PairingStatus, Session, SessionHost, SessionPlugin, SessionRequest, SessionStatus } from '../types';
import {
  chatRecord,
  contactRows,
  CREDS_KEY,
  displayName,
  isGroupJid,
  isLidJid,
  isPhoneJid,
  keyRecord,
  MAX_MESSAGES_PER_CHAT,
  messagesRecord,
  messageText,
  nameRecord,
  normalizeJid,
  parseRecipient,
  phoneOf,
  pnRecord,
  preview,
  resolveName,
  seconds,
  type ChatRecord,
  type NameRecord,
  type StoredMessage,
} from './records';
import type { BaileysApi, ChatSummary, ContactView, MessageView, ReadResult, SendResult, WaAuthState, WaSocket } from './types';

/**
 * The daemon's side of a WhatsApp profile: one Baileys socket, kept open while
 * the vault is unlocked. Every auth-state change, chat, message and name that
 * arrives is written to the profile's store, so `conversations` and `read`
 * answer from the store and keep working across daemon restarts.
 *
 * States: `connecting` → `open`, and back to `connecting` with a growing delay
 * when the connection drops. Two are final. A device the phone logged out is
 * `needs_pairing`; a connection WhatsApp replaced because the same account was
 * opened elsewhere is `replaced`, and reconnecting would only fight the other
 * client for it.
 */

/** Baileys' disconnect status codes that change what the session does. */
const DISCONNECT = {
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408,
  connectionReplaced: 440,
  restartRequired: 515,
} as const;

export const DEFAULT_CONVERSATIONS = 20;
export const DEFAULT_READ = 20;
const MAX_LIMIT = 500;
const MAX_TEXT = 65_536;
const MAX_BACKOFF_MS = 60_000;
/** Sent messages kept in memory, so WhatsApp's retry requests can be answered. */
const SENT_KEPT = 200;

export interface SessionOptions {
  /** First reconnection delay; doubles on each failure. */
  backoffMs?: number;
}

const statusCode = (error: any): number | undefined => error?.output?.statusCode ?? error?.statusCode;
const accountOf = (jid: string | undefined) => {
  const normalized = normalizeJid(jid);
  return normalized ? phoneOf(normalized) ?? normalized : undefined;
};

function stringParam(params: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = params[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new CliError('INVALID_PARAMS', `${name} must be a non-empty string`);
  return value;
}

function limitParam(params: Record<string, unknown>, name: string, fallback: number): number {
  const value = params[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new CliError('INVALID_PARAMS', `${name} must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

export class WhatsAppSession implements Session {
  private sock: WaSocket | null = null;
  private creds: Record<string, any> = {};
  private state: SessionStatus['state'] = 'connecting';
  private detail?: string;
  private account?: string;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly sent = new Map<string, unknown>();

  // Pairing: a session that starts with blank credentials and becomes a normal one once linked.
  private pairing: boolean;
  private pairState: PairingStatus = { state: 'waiting' };
  private codeRequested = false;
  private settle: (result: { session: Session; account?: string } | null) => void = () => {};

  private constructor(
    private readonly api: BaileysApi,
    private readonly host: SessionHost,
    private readonly options: SessionOptions & { phone?: string; pairing: boolean },
  ) {
    this.pairing = options.pairing;
  }

  /** Open the profile's socket from its stored auth state; without one, it needs pairing and stays closed. */
  static async start(api: BaileysApi, host: SessionHost, options: SessionOptions = {}): Promise<WhatsAppSession> {
    const session = new WhatsAppSession(api, host, { ...options, pairing: false });
    const stored = await host.store.get(CREDS_KEY);
    const creds = stored === undefined ? null : api.fromJson(stored);
    if (!creds?.me?.id) {
      session.state = 'needs_pairing';
      session.detail = 'no linked account in the store';
      return session;
    }
    session.creds = creds;
    session.account = accountOf(creds.me.id);
    session.connect();
    return session;
  }

  /** Link a new account into an empty store: QR codes, or a pairing code when `phone` is given. */
  static async pair(api: BaileysApi, host: SessionHost, options: SessionOptions & { phone?: string } = {}): Promise<Pairing> {
    const session = new WhatsAppSession(api, host, { ...options, pairing: true });
    const done = new Promise<{ session: Session; account?: string } | null>((resolve) => { session.settle = resolve; });
    session.creds = api.initAuthCreds();
    await host.store.set(CREDS_KEY, api.toJson(session.creds));
    session.connect();
    return {
      status: () => session.pairState,
      done,
      cancel: () => session.stop(),
    };
  }

  status(): SessionStatus {
    return {
      state: this.state,
      ...(this.account ? { account: this.account } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }

  /** Store writes run one at a time and in order; stop() waits for the last. */
  private queue(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((err) => {
      this.host.log({ outcome: 'store_write_failed', reason: err instanceof Error ? err.message : String(err) });
    });
  }

  private keyStore(): WaAuthState['keys'] {
    const { store } = this.host;
    return {
      get: async (type, ids) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          const value = await store.get(keyRecord(type, id));
          if (value === undefined) continue;
          const decoded = this.api.fromJson(value);
          out[id] = type === 'app-state-sync-key' ? this.api.appStateSyncKey(decoded) : decoded;
        }
        return out;
      },
      set: async (data) => {
        for (const [type, values] of Object.entries(data)) {
          for (const [id, value] of Object.entries(values ?? {})) {
            if (value) await store.set(keyRecord(type, id), this.api.toJson(value));
            else await store.delete(keyRecord(type, id));
          }
        }
      },
    };
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    const sock = this.api.makeSocket({
      auth: { creds: this.creds, keys: this.keyStore() },
      getMessage: async (key) => this.sent.get(key.id ?? ''),
    });
    this.sock = sock;
    const on = (event: string, handle: (payload: any) => Promise<void>) =>
      sock.ev.on(event, (payload) => { if (sock === this.sock) this.queue(() => handle(payload)); });
    sock.ev.on('connection.update', (update) => this.onConnection(sock, update));
    on('creds.update', async () => { await this.host.store.set(CREDS_KEY, this.api.toJson(this.creds)); });
    on('messaging-history.set', (history) => this.onHistory(history));
    on('chats.upsert', (chats) => this.onChats(chats));
    on('chats.update', (chats) => this.onChats(chats));
    on('contacts.upsert', (contacts) => this.onContacts(contacts));
    on('contacts.update', (contacts) => this.onContacts(contacts));
    on('messages.upsert', ({ messages, type }) => this.onMessages(messages ?? [], type === 'notify'));
    on('groups.upsert', (groups) => this.onGroups(groups));
    on('groups.update', (groups) => this.onGroups(groups));
    on('lid-mapping.update', (mapping) => this.onMappings([mapping]));
  }

  private onConnection(sock: WaSocket, update: any): void {
    if (sock !== this.sock) return;
    if (update.qr && this.pairing) this.onQr(sock, update.qr);
    if (update.connection === 'open') this.onOpen(sock);
    if (update.connection === 'close') this.onClose(statusCode(update.lastDisconnect?.error));
  }

  /** The QR code is handed to whoever polls the pairing, never logged. With a phone, a pairing code replaces it. */
  private onQr(sock: WaSocket, qr: string): void {
    if (!this.options.phone) {
      this.pairState = { state: 'waiting', qr };
      return;
    }
    if (this.codeRequested) return;
    this.codeRequested = true;
    sock.requestPairingCode(this.options.phone).then(
      (code) => { if (this.pairing && sock === this.sock) this.pairState = { state: 'waiting', code }; },
      (err) => this.endPairing({ state: 'error', message: `WhatsApp refused a pairing code: ${err instanceof Error ? err.message : String(err)}` }),
    );
  }

  private onOpen(sock: WaSocket): void {
    this.state = 'open';
    this.detail = undefined;
    this.attempts = 0;
    this.account = accountOf(sock.user?.id ?? this.creds.me?.id);
    this.host.log({ outcome: 'open' });
    if (this.pairing) {
      this.pairing = false;
      this.pairState = { state: 'paired', account: this.account };
      this.settle({ session: this, account: this.account });
    }
    void this.afterOpen(sock);
  }

  /** Groups can be listed at any time; contact names come back through the app-state sync. Both best effort. */
  private async afterOpen(sock: WaSocket): Promise<void> {
    try {
      const groups = await sock.groupFetchAllParticipating();
      if (sock === this.sock) this.queue(() => this.onGroups(Object.values(groups)));
    } catch (err) {
      this.host.log({ outcome: 'groups_failed', reason: err instanceof Error ? err.message : String(err) });
    }
    try {
      await sock.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
    } catch (err) {
      this.host.log({ outcome: 'app_state_sync_failed', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  private onClose(code: number | undefined): void {
    this.sock = null;
    if (this.stopped) return;

    if (code === DISCONNECT.loggedOut) {
      this.final('needs_pairing', 'the phone logged this device out');
      // The auth state is dead: a restart must not try it again. Chats and names stay.
      this.queue(() => this.host.store.delete(CREDS_KEY));
      return;
    }
    if (code === DISCONNECT.connectionReplaced) {
      this.final('replaced', 'the account was opened by another client with the same link');
      return;
    }
    if (code === DISCONNECT.forbidden) {
      this.final('closed', 'WhatsApp refused the connection (403); the number may be banned');
      return;
    }
    // After a QR code is scanned, WhatsApp asks for a fresh connection: that is the normal path, not a failure.
    if (code === DISCONNECT.restartRequired) {
      this.connect();
      return;
    }
    if (this.pairing) {
      this.endPairing(code === DISCONNECT.timedOut ? { state: 'expired' } : { state: 'error', message: `the connection closed (${code ?? 'no code'})` });
      return;
    }
    const delay = Math.min((this.options.backoffMs ?? 1000) * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts++;
    this.state = 'connecting';
    this.detail = `reconnecting in ${Math.ceil(delay / 1000)}s after close (${code ?? 'no code'})`;
    this.host.log({ outcome: 'reconnecting', code, delay_ms: delay });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  /** A state the session does not leave on its own. */
  private final(state: 'needs_pairing' | 'replaced' | 'closed', detail: string): void {
    this.state = state;
    this.detail = detail;
    this.host.log({ outcome: state, reason: detail });
    if (this.pairing) this.endPairing({ state: 'error', message: detail });
  }

  private endPairing(status: PairingStatus): void {
    if (!this.pairing) return;
    this.pairState = status;
    this.pairing = false;
    this.stopped = true;
    this.state = 'closed';
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      // Already closed.
    }
    this.settle(null);
  }

  async stop(options: { logout?: boolean } = {}): Promise<void> {
    const wasOpen = this.state === 'open';
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const sock = this.sock;
    this.sock = null;
    if (sock && options.logout && wasOpen) {
      try {
        await Promise.race([sock.logout('removed from agentio'), Bun.sleep(5000)]);
      } catch {
        // Best effort: the phone can unlink the device itself.
      }
    }
    try {
      sock?.end(undefined);
    } catch {
      // Already closed.
    }
    if (this.state !== 'needs_pairing' && this.state !== 'replaced') this.state = 'closed';
    if (this.pairing) {
      this.pairing = false;
      if (this.pairState.state === 'waiting') this.pairState = { state: 'error', message: 'pairing was cancelled' };
      this.settle(null);
    }
    await this.writes;
  }

  // ---- What arrives from WhatsApp ----

  private async pnFor(jid: string): Promise<string | undefined> {
    return isLidJid(jid) ? this.host.store.get<string>(pnRecord(jid)) : undefined;
  }

  /** The JID a person is filed under: their phone JID when a hidden ID's number is known. */
  private async canonical(jid: string): Promise<string> {
    return (await this.pnFor(jid)) ?? jid;
  }

  private async onMappings(mappings: Array<{ lid?: string; pn?: string } | undefined>): Promise<void> {
    for (const mapping of mappings) {
      const lid = normalizeJid(mapping?.lid);
      const pn = normalizeJid(mapping?.pn);
      if (!lid || !pn || !isLidJid(lid) || !isPhoneJid(pn)) continue;
      if ((await this.host.store.get(pnRecord(lid))) === pn) continue;
      await this.host.store.set(pnRecord(lid), pn);
      // Names, chat and messages first seen under the hidden ID now belong to the number.
      const hidden = await this.host.store.get<NameRecord>(nameRecord(lid));
      if (hidden) {
        await this.putNames(pn, { contact: hidden.contact, self: hidden.self });
        await this.host.store.delete(nameRecord(lid));
      }
      await this.mergeChat(lid, pn);
    }
  }

  private async mergeChat(from: string, into: string): Promise<void> {
    const chat = await this.host.store.get<ChatRecord>(chatRecord(from));
    if (chat) {
      const target = await this.host.store.get<ChatRecord>(chatRecord(into));
      const fromIsNewer = (chat.lastMessageAt ?? 0) >= (target?.lastMessageAt ?? 0);
      await this.putChat(into, {
        name: target?.name ?? chat.name,
        unread: (target?.unread ?? 0) + chat.unread,
        ...(fromIsNewer ? { lastMessage: chat.lastMessage, lastMessageAt: chat.lastMessageAt } : {}),
      });
      await this.host.store.delete(chatRecord(from));
    }
    const messages = await this.host.store.get<StoredMessage[]>(messagesRecord(from));
    if (messages) {
      for (const message of messages) {
        await this.putMessage({ ...message, chat: into, sender: message.sender === from ? into : message.sender });
      }
      await this.host.store.delete(messagesRecord(from));
    }
  }

  private async putNames(rawJid: string, names: Partial<Omit<NameRecord, 'jid'>>): Promise<void> {
    const normalized = normalizeJid(rawJid);
    if (!normalized) return;
    const jid = await this.canonical(normalized);
    const defined = Object.fromEntries(Object.entries(names).filter(([, v]) => typeof v === 'string' && v.trim()));
    if (Object.keys(defined).length === 0) return;
    const current = (await this.host.store.get<NameRecord>(nameRecord(jid))) ?? { jid };
    const next = { ...current, ...defined, jid };
    if (JSON.stringify(next) !== JSON.stringify(current)) await this.host.store.set(nameRecord(jid), next);
  }

  private async putChat(jid: string, patch: Partial<ChatRecord>): Promise<void> {
    const current = (await this.host.store.get<ChatRecord>(chatRecord(jid))) ?? { id: jid, unread: 0 };
    const next: ChatRecord = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), id: jid };
    if (JSON.stringify(next) !== JSON.stringify(current)) await this.host.store.set(chatRecord(jid), next);
  }

  private skippable(jid: string | null): jid is null {
    return !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast');
  }

  private async onHistory(history: any): Promise<void> {
    await this.onMappings(history.lidPnMappings ?? []);
    await this.onContacts(history.contacts ?? []);
    await this.onChats(history.chats ?? []);
    await this.onMessages(history.messages ?? [], false);
  }

  private async onChats(chats: any[]): Promise<void> {
    for (const chat of chats ?? []) {
      const jid = normalizeJid(chat?.id);
      if (this.skippable(jid)) continue;
      const at = seconds(chat.conversationTimestamp) ?? seconds(chat.lastMessageRecvTimestamp);
      const current = await this.host.store.get<ChatRecord>(chatRecord(jid));
      await this.putChat(jid, {
        name: chat.name ?? undefined,
        unread: typeof chat.unreadCount === 'number' ? Math.max(0, chat.unreadCount) : undefined,
        lastMessageAt: at !== undefined && at > (current?.lastMessageAt ?? 0) ? at : undefined,
      });
      if (chat.name && isGroupJid(jid)) await this.putNames(jid, { group: chat.name });
    }
  }

  private async onContacts(contacts: any[]): Promise<void> {
    for (const contact of contacts ?? []) {
      if (!contact?.id) continue;
      const lid = normalizeJid(contact.lid) ?? (isLidJid(contact.id) ? normalizeJid(contact.id) : null);
      const pn = normalizeJid(contact.phoneNumber) ?? (isPhoneJid(normalizeJid(contact.id) ?? '') ? normalizeJid(contact.id) : null);
      if (lid && pn) await this.onMappings([{ lid, pn }]);
      await this.putNames(pn ?? lid ?? contact.id, { contact: contact.name, self: contact.notify ?? contact.verifiedName });
    }
  }

  private async onGroups(groups: any[]): Promise<void> {
    for (const group of groups ?? []) {
      const jid = normalizeJid(group?.id);
      if (!jid || !isGroupJid(jid) || !group.subject) continue;
      await this.putNames(jid, { group: group.subject });
      await this.putChat(jid, { name: group.subject });
    }
  }

  private async onMessages(messages: any[], live: boolean): Promise<void> {
    for (const message of messages) {
      const key = message?.key ?? {};
      const raw = normalizeJid(key.remoteJid);
      if (this.skippable(raw)) continue;
      const alt = normalizeJid(key.remoteJidAlt);
      if (alt) await this.onMappings([isLidJid(raw) ? { lid: raw, pn: alt } : { lid: alt, pn: raw }]);
      if (key.participant && key.participantAlt) {
        const participant = normalizeJid(key.participant)!;
        const participantAlt = normalizeJid(key.participantAlt)!;
        await this.onMappings([isLidJid(participant) ? { lid: participant, pn: participantAlt } : { lid: participantAlt, pn: participant }]);
      }
      const chat = await this.canonical(raw);
      const fromMe = !!key.fromMe;
      const participant = isGroupJid(chat) ? normalizeJid(key.participant) ?? undefined : undefined;
      const sender = fromMe ? normalizeJid(this.creds.me?.id) ?? 'me' : await this.canonical(participant ?? chat);
      if (!fromMe && message.pushName) await this.putNames(sender, { self: message.pushName });

      const text = messageText(message.message);
      if (text === null || !key.id) continue;
      const at = seconds(message.messageTimestamp) ?? Math.floor(Date.now() / 1000);
      const stored: StoredMessage = {
        id: key.id, chat, fromMe, sender, text, at,
        ...(participant ? { participant } : {}),
        ...(!fromMe && message.pushName ? { senderName: message.pushName } : {}),
      };
      await this.putMessage(stored);
      const current = await this.host.store.get<ChatRecord>(chatRecord(chat));
      const newer = at >= (current?.lastMessageAt ?? 0);
      await this.putChat(chat, {
        ...(newer ? { lastMessage: preview(text), lastMessageAt: at } : {}),
        ...(live && !fromMe ? { unread: (current?.unread ?? 0) + 1 } : {}),
        ...(fromMe && live ? { unread: 0 } : {}),
      });
    }
  }

  private async putMessage(message: StoredMessage): Promise<void> {
    const list = ((await this.host.store.get<StoredMessage[]>(messagesRecord(message.chat))) ?? []).filter((m) => m.id !== message.id);
    list.push(message);
    list.sort((a, b) => a.at - b.at);
    await this.host.store.set(messagesRecord(message.chat), list.slice(-MAX_MESSAGES_PER_CHAT));
  }

  // ---- The operations the CLI calls ----

  async handle(request: SessionRequest): Promise<unknown> {
    switch (request.operation) {
      case 'conversations': return this.conversations(request.params);
      case 'send': return this.send(request.params, request.readOnly);
      case 'read': return this.read(request.params, request.readOnly);
      case 'contacts': return this.contacts(request.params);
      default: throw new CliError('NOT_FOUND', `Unknown WhatsApp operation: ${request.operation}`);
    }
  }

  private requireOpen(): WaSocket {
    if (this.state === 'open' && this.sock) return this.sock;
    if (this.state === 'needs_pairing') {
      throw new CliError('AUTH_EXPIRED', `This WhatsApp profile needs pairing: ${this.detail}`, 'Run: agentio whatsapp profile add --profile <name>');
    }
    throw new CliError('API_ERROR', `WhatsApp is not connected (${this.state}${this.detail ? `: ${this.detail}` : ''})`,
      this.state === 'replaced'
        ? 'Another client uses this link; stop it, then restart the daemon'
        : 'Try again in a moment, or check `agentio whatsapp status`');
  }

  private async names(): Promise<NameRecord[]> {
    return (await this.host.store.list<NameRecord>('name:')).map((r) => r.value);
  }

  private async summary(chat: ChatRecord): Promise<ChatSummary> {
    const names = await this.host.store.get<NameRecord>(nameRecord(chat.id));
    const name = displayName(names, chat.name);
    const phone = phoneOf(chat.id) ?? phoneOf(await this.pnFor(chat.id));
    return {
      id: chat.id,
      ...(name ? { name } : {}),
      ...(phone ? { phone } : {}),
      isGroup: isGroupJid(chat.id),
      ...(chat.lastMessage !== undefined ? { lastMessage: chat.lastMessage } : {}),
      ...(chat.lastMessageAt !== undefined ? { lastMessageAt: chat.lastMessageAt } : {}),
      unread: chat.unread,
    };
  }

  private async conversations(params: Record<string, unknown>): Promise<ChatSummary[]> {
    const limit = limitParam(params, 'limit', DEFAULT_CONVERSATIONS);
    const unreadOnly = params.unreadOnly === true;
    const chats = (await this.host.store.list<ChatRecord>('chat:')).map((r) => r.value)
      .filter((chat) => !unreadOnly || chat.unread > 0)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.id.localeCompare(b.id))
      .slice(0, limit);
    return Promise.all(chats.map((chat) => this.summary(chat)));
  }

  private async contacts(params: Record<string, unknown>): Promise<ContactView[]> {
    return contactRows(await this.names(), stringParam(params, 'query', false));
  }

  /**
   * The chat a recipient stands for. A number being sent to is first checked
   * with WhatsApp; a name must be one the store knows, exactly.
   */
  private async target(input: string, checkNumber: boolean): Promise<{ jid: string; name?: string }> {
    const recipient = parseRecipient(input);
    if (recipient.kind === 'jid') return { jid: await this.canonical(recipient.jid) };
    if (recipient.kind === 'name') return resolveName(await this.names(), recipient.name);
    if (!checkNumber) return { jid: `${recipient.digits}@s.whatsapp.net` };
    const [found] = (await this.requireOpen().onWhatsApp(recipient.digits)) ?? [];
    if (!found?.exists) {
      throw new CliError('NOT_FOUND', `+${recipient.digits} is not on WhatsApp`, 'Check the number, including its country code');
    }
    return { jid: normalizeJid(found.jid) ?? `${recipient.digits}@s.whatsapp.net` };
  }

  private async send(params: Record<string, unknown>, readOnly: boolean): Promise<SendResult> {
    if (readOnly) throw new CliError('PERMISSION_DENIED', 'Cannot send: this WhatsApp profile is read-only');
    const to = stringParam(params, 'to', true)!;
    const text = stringParam(params, 'text', true)!;
    if (text.length > MAX_TEXT) throw new CliError('INVALID_PARAMS', `A message is at most ${MAX_TEXT} characters`);
    const sock = this.requireOpen();
    const target = await this.target(to, true);
    const sent = await sock.sendMessage(target.jid, { text });
    const id = sent?.key?.id;
    if (!id) throw new CliError('API_ERROR', 'WhatsApp did not acknowledge the message');
    this.sent.set(id, sent.message);
    if (this.sent.size > SENT_KEPT) this.sent.delete(this.sent.keys().next().value!);
    this.queue(() => this.onMessages([sent], true));
    await this.writes;
    const names = await this.host.store.get<NameRecord>(nameRecord(target.jid));
    const toName = target.name ?? displayName(names);
    return { id, to: target.jid, ...(toName ? { toName } : {}), timestamp: seconds(sent.messageTimestamp) ?? Math.floor(Date.now() / 1000) };
  }

  /**
   * The last messages of a chat, from the store. Returned incoming messages
   * are marked as read on WhatsApp unless the caller opts out or the profile
   * is read-only; with no connection, the messages still come back, unmarked.
   */
  private async read(params: Record<string, unknown>, readOnly: boolean): Promise<ReadResult> {
    const chatInput = stringParam(params, 'chat', true)!;
    const last = limitParam(params, 'last', DEFAULT_READ);
    const wantReceipts = params.receipts !== false && !readOnly;
    const { jid } = await this.target(chatInput, false);

    const stored = (await this.host.store.get<StoredMessage[]>(messagesRecord(jid))) ?? [];
    const messages = stored.slice(-last);
    const chat = (await this.host.store.get<ChatRecord>(chatRecord(jid))) ?? { id: jid, unread: 0 };

    let receiptsSent = 0;
    const incoming = messages.filter((m) => !m.fromMe);
    if (wantReceipts && incoming.length > 0 && this.state === 'open' && this.sock) {
      await this.sock.readMessages(incoming.map((m) => ({ remoteJid: m.chat, id: m.id, fromMe: false, ...(m.participant ? { participant: m.participant } : {}) })));
      receiptsSent = incoming.length;
      if (chat.unread > 0) {
        this.queue(() => this.putChat(jid, { unread: 0 }));
        chat.unread = 0;
      }
    }
    const view = (m: StoredMessage): MessageView => ({
      id: m.id, fromMe: m.fromMe, sender: m.sender, text: m.text, at: m.at,
      ...(m.senderName ? { senderName: m.senderName } : {}),
    });
    return { chat: await this.summary(chat), messages: messages.map(view), receiptsSent };
  }
}

/** Baileys itself, loaded only when a session starts, so the CLI never pays for it. */
async function loadBaileys(): Promise<BaileysApi> {
  const baileys = await import('baileys');
  const makeSocket = baileys.makeWASocket ?? baileys.default;
  const silent: any = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
  silent.child = () => silent;
  return {
    makeSocket: ({ auth, getMessage }) => makeSocket({
      auth: { creds: auth.creds as any, keys: baileys.makeCacheableSignalKeyStore(auth.keys as any, silent) },
      logger: silent,
      browser: baileys.Browsers.macOS('Chrome'),
      // The phone keeps its notifications: this device never claims to be the one in use.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: getMessage as any,
    }) as unknown as WaSocket,
    initAuthCreds: () => baileys.initAuthCreds() as any,
    toJson: (value) => JSON.parse(JSON.stringify(value, baileys.BufferJSON.replacer)),
    fromJson: (value) => JSON.parse(JSON.stringify(value), baileys.BufferJSON.reviver),
    appStateSyncKey: (value) => baileys.proto.Message.AppStateSyncKeyData.fromObject(value as any),
  };
}

/** The session capability of the WhatsApp plugin. Tests pass a fake Baileys. */
export function whatsappSessions(load: () => Promise<BaileysApi> = loadBaileys, options: SessionOptions = {}): SessionPlugin {
  return {
    writeOperations: ['send'],
    start: async (_profile, host) => WhatsAppSession.start(await load(), host, options),
    pair: async (_profile, { phone }, host) => WhatsAppSession.pair(await load(), host, { ...options, phone }),
  };
}
