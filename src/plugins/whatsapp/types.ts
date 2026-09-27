/**
 * What the daemon's WhatsApp session answers, as the CLI receives it. The
 * daemon and the CLI share these shapes, so they stay in step.
 */

/** Where a known name comes from: saved on the phone, set by the person, or a group's subject. */
export type NameSource = 'contact' | 'self' | 'group';

export interface ChatSummary {
  /** The chat's JID: `…@s.whatsapp.net`, `…@g.us`, or a hidden `…@lid`. */
  id: string;
  name?: string;
  /** `+<digits>`, when the chat is a person whose number is known. */
  phone?: string;
  isGroup: boolean;
  lastMessage?: string;
  /** Seconds since the epoch. */
  lastMessageAt?: number;
  unread: number;
}

export interface MessageView {
  id: string;
  fromMe: boolean;
  /** The sender's JID; in a group, the member who wrote. */
  sender: string;
  senderName?: string;
  text: string;
  /** Seconds since the epoch. */
  at: number;
}

export interface ReadResult {
  chat: ChatSummary;
  messages: MessageView[];
  /** How many of the returned messages were marked as read on WhatsApp. */
  receiptsSent: number;
}

export interface ContactView {
  name: string;
  jid: string;
  /** `+<digits>`, or absent for a hidden ID whose number is unknown. */
  phone?: string;
  source: NameSource;
}

export interface SendResult {
  id: string;
  to: string;
  toName?: string;
  /** Seconds since the epoch. */
  timestamp: number;
}

/** What `GET /v1/sessions/whatsapp/:name` answers. */
export interface WhatsAppStatus {
  state: 'connecting' | 'open' | 'needs_pairing' | 'replaced' | 'closed';
  account?: string;
  detail?: string;
  readOnly: boolean;
}

/** What `GET …/pair` answers. */
export type PairState =
  | { state: 'waiting'; qr?: string; code?: string }
  | { state: 'paired'; account?: string }
  | { state: 'expired' }
  | { state: 'error'; message: string };

/** All the vault holds for a profile: the key of its store. */
export interface WhatsAppCredentials {
  storeKey: string;
}

/**
 * The slice of a Baileys socket the session uses. Tests implement it, so
 * nothing but the default loader imports Baileys.
 */
export interface WaSocket {
  ev: {
    on(event: string, listener: (payload: any) => void): void;
    removeAllListeners(event: string): void;
  };
  user?: { id: string; lid?: string; name?: string };
  sendMessage(jid: string, content: { text: string }): Promise<any>;
  onWhatsApp(...numbers: string[]): Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  readMessages(keys: Array<{ remoteJid: string; id: string; participant?: string; fromMe: boolean }>): Promise<void>;
  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string }>>;
  requestPairingCode(phone: string): Promise<string>;
  resyncAppState?(collections: readonly string[], isInitialSync: boolean): Promise<void>;
  logout(message?: string): Promise<void>;
  end(error: Error | undefined): void;
}

/** The auth state a socket is opened with, in Baileys' shape. */
export interface WaAuthState {
  creds: Record<string, any>;
  keys: {
    get(type: string, ids: string[]): Promise<Record<string, any>>;
    set(data: Record<string, Record<string, any>>): Promise<void>;
  };
}

/** The parts of Baileys the session needs, loaded on demand. */
export interface BaileysApi {
  makeSocket(options: { auth: WaAuthState; getMessage: (key: { id?: string | null }) => Promise<any> }): WaSocket;
  initAuthCreds(): Record<string, any>;
  /** Encode a value, Buffers included, as plain JSON; and back. */
  toJson(value: unknown): unknown;
  fromJson(value: unknown): any;
  /** Baileys wants app-state keys back as protobuf objects. */
  appStateSyncKey(value: unknown): unknown;
}
