import { CliError } from '../../utils/errors';
import type { ContactView, MediaKind, NameSource } from './types';

/**
 * What the WhatsApp session keeps in its store, and the pure rules over it:
 * a message's text, a JID's phone number, and how a name the user typed
 * resolves to a chat.
 *
 * Records, by key:
 * - `auth:creds` and `auth:key:<type>:<id>`: the Baileys auth state.
 * - `chat:<jid>`: one chat of the index.
 * - `msgs:<jid>`: its most recent messages, oldest first: their text, and for
 *   media what it takes to download the file later (never the file itself).
 * - `name:<jid>`: the names known for a person or group, by source.
 * - `pn:<lid>`: the phone JID a hidden ID is known to belong to.
 */

/** Messages kept per chat; the oldest are dropped first. */
export const MAX_MESSAGES_PER_CHAT = 100;
/** A chat's preview of its last message is cut to this many characters. */
export const PREVIEW_LENGTH = 100;

export const CREDS_KEY = 'auth:creds';
export const keyRecord = (type: string, id: string) => `auth:key:${type}:${id}`;
export const chatRecord = (jid: string) => `chat:${jid}`;
export const messagesRecord = (jid: string) => `msgs:${jid}`;
export const nameRecord = (jid: string) => `name:${jid}`;
export const pnRecord = (lid: string) => `pn:${lid}`;

export interface ChatRecord {
  id: string;
  name?: string;
  unread: number;
  lastMessage?: string;
  lastMessageAt?: number;
}

export interface StoredMessage {
  id: string;
  chat: string;
  /** The member who wrote, in a group; needed to send its read receipt. */
  participant?: string;
  fromMe: boolean;
  sender: string;
  senderName?: string;
  text: string;
  at: number;
  /** Set for media received since media details are kept; older media has only its placeholder text. */
  media?: StoredMedia;
}

/** What it takes to fetch a media file from WhatsApp's servers and decrypt it, and to name it. */
export interface StoredMedia {
  kind: MediaKind;
  mimetype?: string;
  /** A document's own name. */
  fileName?: string;
  /** In bytes. */
  size?: number;
  url?: string;
  directPath: string;
  /** The file's decryption key, base64. */
  mediaKey: string;
}

export interface NameRecord {
  jid: string;
  contact?: string;
  self?: string;
  group?: string;
}

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
export const isLidJid = (jid: string) => jid.endsWith('@lid');
export const isPhoneJid = (jid: string) => jid.endsWith('@s.whatsapp.net');

/** A JID without its device part, with the legacy `c.us` server read as a phone one. */
export function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid || !jid.includes('@')) return null;
  const at = jid.indexOf('@');
  const user = jid.slice(0, at).split(':')[0]!;
  const server = jid.slice(at + 1);
  return `${user}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

/** `+<digits>` for a phone JID, else undefined. */
export function phoneOf(jid: string | undefined): string | undefined {
  return jid && isPhoneJid(jid) ? `+${jid.slice(0, jid.indexOf('@'))}` : undefined;
}

/** Messages that are not something a person wrote: receipts, reactions, key exchanges. */
const NOT_A_MESSAGE = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage', 'pollUpdateMessage']);
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];

/** The message inside the wrappers WhatsApp puts around disappearing, view-once, captioned and edited ones. */
function unwrap(message: any): any {
  for (const wrapper of WRAPPERS) {
    if (message[wrapper]?.message) return unwrap(message[wrapper].message);
  }
  return message;
}

/**
 * The text of a message, with a placeholder such as `[image]` for media, or
 * null when it is not something a person wrote. Media itself is never kept.
 */
export function messageText(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = unwrap(raw);
  if (typeof message.conversation === 'string' && message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  const captioned = (label: string, caption?: string | null) => (caption ? `[${label}] ${caption}` : `[${label}]`);
  if (message.imageMessage) return captioned('image', message.imageMessage.caption);
  if (message.videoMessage) return captioned(message.videoMessage.gifPlayback ? 'gif' : 'video', message.videoMessage.caption);
  if (message.audioMessage) return message.audioMessage.ptt ? '[voice message]' : '[audio]';
  if (message.documentMessage) return captioned(`document${message.documentMessage.fileName ? `: ${message.documentMessage.fileName}` : ''}`, message.documentMessage.caption);
  if (message.stickerMessage) return '[sticker]';
  if (message.contactMessage || message.contactsArrayMessage) return '[contact]';
  if (message.locationMessage || message.liveLocationMessage) return '[location]';
  const poll = message.pollCreationMessage ?? message.pollCreationMessageV2 ?? message.pollCreationMessageV3;
  if (poll) return captioned('poll', poll.name);
  const kinds = Object.keys(message).filter((key) => message[key] != null && !NOT_A_MESSAGE.has(key));
  return kinds.length > 0 ? '[message]' : null;
}

const MEDIA_FIELDS: ReadonlyArray<[string, MediaKind]> = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
];

function base64(value: unknown): string | undefined {
  if (value instanceof Uint8Array) return value.length > 0 ? Buffer.from(value).toString('base64') : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * What it takes to download a message's media later, or null when it has
 * none. Thumbnails, captions and quoted messages are left out: the store
 * keeps only the file's address, key and description.
 */
export function messageMedia(raw: any): StoredMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = unwrap(raw);
  for (const [field, kind] of MEDIA_FIELDS) {
    const media = message[field];
    if (!media) continue;
    const mediaKey = base64(media.mediaKey);
    if (typeof media.directPath !== 'string' || !media.directPath || !mediaKey) return null;
    const size = positiveNumber(media.fileLength);
    return {
      kind,
      ...(typeof media.mimetype === 'string' && media.mimetype ? { mimetype: media.mimetype } : {}),
      ...(kind === 'document' && typeof media.fileName === 'string' && media.fileName ? { fileName: media.fileName } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(typeof media.url === 'string' && media.url ? { url: media.url } : {}),
      directPath: media.directPath,
      mediaKey,
    };
  }
  return null;
}

/** The media kind behind a placeholder messageText wrote, for media stored before its details were kept. */
export function placeholderKind(text: string): MediaKind | null {
  const label = /^\[(image|gif|video|audio|voice message|sticker|document)(?::[^\]]*)?\]/.exec(text)?.[1];
  switch (label) {
    case 'image': return 'image';
    case 'gif': case 'video': return 'video';
    case 'audio': case 'voice message': return 'audio';
    case 'sticker': return 'sticker';
    case 'document': return 'document';
    default: return null;
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
};
const DEFAULT_EXTENSIONS: Record<MediaKind, string> = { image: 'jpg', video: 'mp4', audio: 'ogg', document: 'bin', sticker: 'webp' };

/** The file extension for a media file, from its MIME type, else from its kind. */
export function mediaExtension(media: Pick<StoredMedia, 'kind' | 'mimetype'>): string {
  const type = media.mimetype?.split(';')[0]!.trim().toLowerCase();
  if (type && EXTENSIONS[type]) return EXTENSIONS[type];
  const subtype = type?.split('/')[1];
  return subtype && /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : DEFAULT_EXTENSIONS[media.kind];
}

/** A name that is safe as one file on any disk: no separators, control or reserved characters, no leading dot. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize('NFC')
    .replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return cleaned || 'file';
}

/**
 * The name a media file is saved under: the message's date and time (UTC),
 * then its ID and an extension, so names sort by date and two messages never
 * share one. A document keeps its own name after the date instead of the ID.
 */
export function mediaFileName(message: { id: string; at: number }, media: Pick<StoredMedia, 'kind' | 'mimetype' | 'fileName'>): string {
  const stamp = new Date(message.at * 1000).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  if (media.kind === 'document' && media.fileName) {
    const own = safeFileName(media.fileName);
    return `${stamp}_${/\.[a-z0-9]{1,8}$/i.test(own) ? own : `${own}.${mediaExtension(media)}`}`;
  }
  return `${stamp}_${safeFileName(message.id)}.${mediaExtension(media)}`;
}

/** A positive number from Baileys' number, Long or string values; anything else is none. */
function positiveNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === 'object' && value !== null && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Seconds since the epoch from Baileys' number, Long or string timestamps. */
export function seconds(value: unknown): number | undefined {
  return positiveNumber(value);
}

export const preview = (text: string) => (text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text);

/** Case, accents and spacing do not count when matching a name. */
export function foldName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** What the user typed for a chat or recipient. */
export type Recipient = { kind: 'jid'; jid: string } | { kind: 'phone'; digits: string } | { kind: 'name'; name: string };

export function parseRecipient(input: string): Recipient {
  const text = input.trim();
  if (!text) throw new CliError('INVALID_PARAMS', 'A recipient is required', 'Use a phone number such as +33612345678, a JID, or a known name');
  if (text.includes('@')) {
    const jid = normalizeJid(text);
    if (!jid || !/^[\w.-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(jid)) {
      throw new CliError('INVALID_PARAMS', `"${input}" is not a WhatsApp JID`, 'A JID ends in @s.whatsapp.net, @g.us or @lid');
    }
    return { kind: 'jid', jid };
  }
  if (/^\+?[\d\s().-]+$/.test(text)) {
    const digits = text.replace(/\D/g, '');
    if (!/^[1-9]\d{6,14}$/.test(digits)) {
      throw new CliError('INVALID_PARAMS', `"${input}" is not a phone number in international format`, 'Include the country code, for example +33612345678');
    }
    return { kind: 'phone', digits };
  }
  return { kind: 'name', name: text };
}

/** The name to show for a JID: the one saved on the phone, else the group's, else the chat's, else the person's own. */
export function displayName(record: NameRecord | undefined, chatName?: string): string | undefined {
  return record?.contact ?? record?.group ?? chatName ?? record?.self;
}

/** One row per known name and source, matching `query` when there is one, sorted by name. */
export function contactRows(records: NameRecord[], query?: string): ContactView[] {
  const wanted = query?.trim() ? foldName(query) : null;
  const rows: ContactView[] = [];
  for (const record of records) {
    for (const source of ['contact', 'self', 'group'] as NameSource[]) {
      const name = record[source];
      if (!name || (wanted !== null && !foldName(name).includes(wanted))) continue;
      rows.push({ name, jid: record.jid, ...(phoneOf(record.jid) ? { phone: phoneOf(record.jid) } : {}), source });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.jid.localeCompare(b.jid));
}

const describe = (row: ContactView) => `${row.name} (${row.phone ?? row.jid}, ${row.source})`;

/**
 * The one JID a name stands for, from the known names only. Every source
 * counts, and an exact match (ignoring case and accents) is required: sending
 * to a partial match could reach the wrong person. Several people under the
 * same name, or none, is an error that says who was found.
 */
export function resolveName(records: NameRecord[], name: string): { jid: string; name: string } {
  const exact = contactRows(records).filter((row) => foldName(row.name) === foldName(name));
  const jids = [...new Set(exact.map((row) => row.jid))];
  if (jids.length === 1) return { jid: jids[0]!, name: exact[0]!.name };
  if (jids.length > 1) {
    throw new CliError('INVALID_PARAMS', `"${name}" matches several chats: ${exact.map(describe).join('; ')}`,
      'Use the phone number or the JID of the one you mean');
  }
  const partial = contactRows(records, name).slice(0, 5);
  throw new CliError('NOT_FOUND', `No known WhatsApp name is "${name}"${partial.length ? `. Close ones: ${partial.map(describe).join('; ')}` : ''}`,
    'Use the phone number, for example +33612345678, or run `agentio whatsapp contacts` to see the names known');
}
