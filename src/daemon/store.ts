import { Database } from 'bun:sqlite';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureConfigDir, CONFIG_DIR } from '../config/config-manager';
import type { ServiceName } from '../types/config';
import type {
  InboundMessage,
  OutboundMessage,
  InboxStatus,
  OutboxStatus,
  MediaType,
} from './types';

const DATABASE_FILE = join(CONFIG_DIR, 'gateway.db');

let db: Database | null = null;

/**
 * Initialize the database and create tables if needed
 */
export async function initDatabase(): Promise<Database> {
  if (db) return db;

  await ensureConfigDir();

  db = new Database(DATABASE_FILE);

  // Enable WAL mode for better concurrent access
  db.run('PRAGMA journal_mode = WAL');

  // Create inbox table
  db.run(`
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      profile TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      platform_id TEXT NOT NULL,

      sender_id TEXT NOT NULL,
      sender_name TEXT,
      sender_handle TEXT,

      content TEXT,
      media_type TEXT,
      media_path TEXT,

      received_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      done_at INTEGER,

      reply_to_id TEXT,
      metadata TEXT,

      UNIQUE(service, profile, platform_id)
    )
  `);

  // Create outbox table
  db.run(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      profile TEXT NOT NULL,
      conversation_id TEXT NOT NULL,

      content TEXT,
      media_path TEXT,
      media_type TEXT,

      reply_to_platform_id TEXT,

      queued_at INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      sent_at INTEGER,
      error TEXT,
      platform_id TEXT,

      metadata TEXT
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(service, profile, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox(received_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(service, profile, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_outbox_queued ON outbox(queued_at)');

  // WhatsApp auth state tables (for Baileys)
  // Stores authentication credentials (keys, registration info)
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_creds (
      profile TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Stores session keys (pre-keys, sender keys, etc.)
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
      profile TEXT NOT NULL,
      type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (profile, type, key_id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_keys ON whatsapp_auth_keys(profile, type)');

  return db;
}

/**
 * Get the database instance (must call initDatabase first)
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============ INBOX OPERATIONS ============

interface InboxRow {
  id: string;
  service: string;
  profile: string;
  conversation_id: string;
  platform_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_handle: string | null;
  content: string | null;
  media_type: string | null;
  media_path: string | null;
  received_at: number;
  status: string;
  done_at: number | null;
  reply_to_id: string | null;
  metadata: string | null;
}

function rowToInboundMessage(row: InboxRow): InboundMessage {
  return {
    id: row.id,
    service: row.service as ServiceName,
    profile: row.profile,
    conversationId: row.conversation_id,
    platformId: row.platform_id,
    senderId: row.sender_id,
    senderName: row.sender_name ?? undefined,
    senderHandle: row.sender_handle ?? undefined,
    content: row.content ?? undefined,
    mediaType: row.media_type as MediaType | undefined,
    mediaPath: row.media_path ?? undefined,
    receivedAt: row.received_at,
    status: row.status as InboxStatus,
    doneAt: row.done_at ?? undefined,
    replyToId: row.reply_to_id ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

/**
 * Insert a new message into the inbox
 */
export function insertInboxMessage(message: Omit<InboundMessage, 'id' | 'status' | 'doneAt'>): InboundMessage {
  const db = getDatabase();
  const id = randomUUID();

  db.run(
    `INSERT INTO inbox (id, service, profile, conversation_id, platform_id, sender_id, sender_name, sender_handle, content, media_type, media_path, received_at, status, reply_to_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      message.service,
      message.profile,
      message.conversationId,
      message.platformId,
      message.senderId,
      message.senderName ?? null,
      message.senderHandle ?? null,
      message.content ?? null,
      message.mediaType ?? null,
      message.mediaPath ?? null,
      message.receivedAt,
      message.replyToId ?? null,
      message.metadata ? JSON.stringify(message.metadata) : null,
    ]
  );

  return {
    ...message,
    id,
    status: 'pending',
  };
}

/**
 * Check if a message already exists (by platform ID)
 */
export function inboxMessageExists(service: ServiceName, profile: string, platformId: string): boolean {
  const db = getDatabase();
  const row = db.query(
    'SELECT 1 FROM inbox WHERE service = ? AND profile = ? AND platform_id = ?'
  ).get(service, profile, platformId);
  return !!row;
}

/**
 * Get messages from inbox
 */
export function getInboxMessages(options: {
  service?: ServiceName;
  profile?: string;
  conversationId?: string;
  status?: InboxStatus;
  limit?: number;
}): InboundMessage[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.service) {
    conditions.push('service = ?');
    params.push(options.service);
  }
  if (options.profile) {
    conditions.push('profile = ?');
    params.push(options.profile);
  }
  if (options.conversationId) {
    conditions.push('conversation_id = ?');
    params.push(options.conversationId);
  }
  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ? `LIMIT ${options.limit}` : '';

  const rows = db.query<InboxRow, (string | number)[]>(
    `SELECT * FROM inbox ${where} ORDER BY received_at ASC ${limit}`
  ).all(...params);

  return rows.map(rowToInboundMessage);
}

/**
 * Get a single inbox message by ID (supports partial ID prefix matching)
 */
export function getInboxMessage(id: string): InboundMessage | null {
  const db = getDatabase();

  // Full UUID is 36 characters, if shorter try prefix match
  if (id.length < 36) {
    const rows = db.query<InboxRow, [string]>(
      'SELECT * FROM inbox WHERE id LIKE ? LIMIT 2'
    ).all(`${id}%`);

    // Only return if exactly one match (avoid ambiguity)
    if (rows.length === 1) {
      return rowToInboundMessage(rows[0]);
    }
    return null;
  }

  const row = db.query<InboxRow, [string]>(
    'SELECT * FROM inbox WHERE id = ?'
  ).get(id);

  return row ? rowToInboundMessage(row) : null;
}

/**
 * Mark an inbox message as done (supports partial ID prefix matching)
 */
export function ackInboxMessage(id: string): boolean {
  const db = getDatabase();

  // Full UUID is 36 characters, if shorter resolve full ID first
  let fullId = id;
  if (id.length < 36) {
    const message = getInboxMessage(id);
    if (!message) return false;
    fullId = message.id;
  }

  const result = db.run(
    'UPDATE inbox SET status = ?, done_at = ? WHERE id = ? AND status = ?',
    ['done', Date.now(), fullId, 'pending']
  );
  return result.changes > 0;
}

/**
 * Get inbox statistics
 */
export function getInboxStats(options: {
  service?: ServiceName;
  profile?: string;
}): { pending: number; done: number; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.service) {
    conditions.push('service = ?');
    params.push(options.service);
  }
  if (options.profile) {
    conditions.push('profile = ?');
    params.push(options.profile);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = db.query<{ pending: number; done: number; total: number }, string[]>(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
       COUNT(*) as total
     FROM inbox ${where}`
  ).get(...params);

  return row ?? { pending: 0, done: 0, total: 0 };
}

/**
 * Delete old processed messages (retention cleanup)
 */
export function cleanupInbox(daysOld: number): number {
  if (daysOld <= 0) return 0;
  const db = getDatabase();
  const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
  const result = db.run(
    'DELETE FROM inbox WHERE status = ? AND done_at < ?',
    ['done', cutoff]
  );
  return result.changes;
}

// ============ OUTBOX OPERATIONS ============

interface OutboxRow {
  id: string;
  service: string;
  profile: string;
  conversation_id: string;
  content: string | null;
  media_path: string | null;
  media_type: string | null;
  reply_to_platform_id: string | null;
  queued_at: number;
  status: string;
  sent_at: number | null;
  error: string | null;
  platform_id: string | null;
  metadata: string | null;
}

function rowToOutboundMessage(row: OutboxRow): OutboundMessage {
  return {
    id: row.id,
    service: row.service as ServiceName,
    profile: row.profile,
    conversationId: row.conversation_id,
    content: row.content ?? undefined,
    mediaPath: row.media_path ?? undefined,
    mediaType: row.media_type as MediaType | undefined,
    replyToPlatformId: row.reply_to_platform_id ?? undefined,
    queuedAt: row.queued_at,
    status: row.status as OutboxStatus,
    sentAt: row.sent_at ?? undefined,
    error: row.error ?? undefined,
    platformId: row.platform_id ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

/**
 * Queue a new message for sending
 */
export function queueOutboxMessage(message: Omit<OutboundMessage, 'id' | 'status' | 'queuedAt'>): OutboundMessage {
  const db = getDatabase();
  const id = randomUUID();
  const queuedAt = Date.now();

  db.run(
    `INSERT INTO outbox (id, service, profile, conversation_id, content, media_path, media_type, reply_to_platform_id, queued_at, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      message.service,
      message.profile,
      message.conversationId,
      message.content ?? null,
      message.mediaPath ?? null,
      message.mediaType ?? null,
      message.replyToPlatformId ?? null,
      queuedAt,
      message.metadata ? JSON.stringify(message.metadata) : null,
    ]
  );

  return {
    ...message,
    id,
    status: 'pending',
    queuedAt,
  };
}

/**
 * Get pending outbox messages for processing
 */
export function getPendingOutboxMessages(options?: {
  service?: ServiceName;
  profile?: string;
  limit?: number;
}): OutboundMessage[] {
  const db = getDatabase();
  const conditions: string[] = ['status = ?'];
  const params: (string | number)[] = ['pending'];

  if (options?.service) {
    conditions.push('service = ?');
    params.push(options.service);
  }
  if (options?.profile) {
    conditions.push('profile = ?');
    params.push(options.profile);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = options?.limit ? `LIMIT ${options.limit}` : '';

  const rows = db.query<OutboxRow, (string | number)[]>(
    `SELECT * FROM outbox ${where} ORDER BY queued_at ASC ${limit}`
  ).all(...params);

  return rows.map(rowToOutboundMessage);
}

/**
 * Get outbox messages with filters
 */
export function getOutboxMessages(options: {
  service?: ServiceName;
  profile?: string;
  status?: OutboxStatus;
  limit?: number;
}): OutboundMessage[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.service) {
    conditions.push('service = ?');
    params.push(options.service);
  }
  if (options.profile) {
    conditions.push('profile = ?');
    params.push(options.profile);
  }
  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ? `LIMIT ${options.limit}` : '';

  const rows = db.query<OutboxRow, (string | number)[]>(
    `SELECT * FROM outbox ${where} ORDER BY queued_at DESC ${limit}`
  ).all(...params);

  return rows.map(rowToOutboundMessage);
}

/**
 * Get a single outbox message by ID (supports partial ID prefix matching)
 */
export function getOutboxMessage(id: string): OutboundMessage | null {
  const db = getDatabase();

  // Full UUID is 36 characters, if shorter try prefix match
  if (id.length < 36) {
    const rows = db.query<OutboxRow, [string]>(
      'SELECT * FROM outbox WHERE id LIKE ? LIMIT 2'
    ).all(`${id}%`);

    // Only return if exactly one match (avoid ambiguity)
    if (rows.length === 1) {
      return rowToOutboundMessage(rows[0]);
    }
    return null;
  }

  const row = db.query<OutboxRow, [string]>(
    'SELECT * FROM outbox WHERE id = ?'
  ).get(id);

  return row ? rowToOutboundMessage(row) : null;
}

/**
 * Update outbox message status (for processing)
 */
export function updateOutboxStatus(
  id: string,
  status: OutboxStatus,
  options?: { error?: string; platformId?: string }
): boolean {
  const db = getDatabase();
  const updates: string[] = ['status = ?'];
  const params: (string | number | null)[] = [status];

  if (status === 'sent') {
    updates.push('sent_at = ?');
    params.push(Date.now());
  }
  if (options?.error !== undefined) {
    updates.push('error = ?');
    params.push(options.error);
  }
  if (options?.platformId !== undefined) {
    updates.push('platform_id = ?');
    params.push(options.platformId);
  }

  params.push(id);

  const result = db.run(
    `UPDATE outbox SET ${updates.join(', ')} WHERE id = ?`,
    params
  );
  return result.changes > 0;
}

/**
 * Delete old sent messages (retention cleanup)
 */
export function cleanupOutbox(daysOld: number): number {
  if (daysOld <= 0) return 0;
  const db = getDatabase();
  const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
  const result = db.run(
    'DELETE FROM outbox WHERE status = ? AND sent_at < ?',
    ['sent', cutoff]
  );
  return result.changes;
}

// ============ WHATSAPP AUTH STATE EXPORT/IMPORT ============

export interface WhatsAppAuthExport {
  profile: string;
  creds: string | null;  // JSON string
  keys: { type: string; keyId: string; data: string }[];
}

/**
 * Export WhatsApp auth state for teleport
 */
export async function exportWhatsAppAuthState(profile: string): Promise<WhatsAppAuthExport | null> {
  const db = getDatabase();

  // Get credentials
  const credsRow = db.query<{ data: string }, [string]>(
    'SELECT data FROM whatsapp_auth_creds WHERE profile = ?'
  ).get(profile);

  // Get all keys
  const keysRows = db.query<{ type: string; key_id: string; data: string }, [string]>(
    'SELECT type, key_id, data FROM whatsapp_auth_keys WHERE profile = ?'
  ).all(profile);

  if (!credsRow && keysRows.length === 0) {
    return null;
  }

  return {
    profile,
    creds: credsRow?.data || null,
    keys: keysRows.map(row => ({
      type: row.type,
      keyId: row.key_id,
      data: row.data,
    })),
  };
}

/**
 * Import WhatsApp auth state from teleport
 */
export async function importWhatsAppAuthState(authExport: WhatsAppAuthExport): Promise<void> {
  const db = getDatabase();
  const { profile, creds, keys } = authExport;

  // Clear existing auth state for this profile
  db.run('DELETE FROM whatsapp_auth_creds WHERE profile = ?', [profile]);
  db.run('DELETE FROM whatsapp_auth_keys WHERE profile = ?', [profile]);

  // Import credentials
  if (creds) {
    db.run(
      'INSERT INTO whatsapp_auth_creds (profile, data, updated_at) VALUES (?, ?, ?)',
      [profile, creds, Date.now()]
    );
  }

  // Import keys
  for (const key of keys) {
    db.run(
      'INSERT INTO whatsapp_auth_keys (profile, type, key_id, data) VALUES (?, ?, ?, ?)',
      [profile, key.type, key.keyId, key.data]
    );
  }
}

export { DATABASE_FILE };
