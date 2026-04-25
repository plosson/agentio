import type { Database } from 'bun:sqlite';
import type { ServiceName } from '../../types/config';

export interface ChatSession {
  service: ServiceName;
  profile: string;
  chatId: string;
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
  turnCount: number;
}

export function createChatSessionsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      service TEXT NOT NULL,
      profile TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (service, profile, chat_id)
    )
  `);
}

interface Row {
  service: string;
  profile: string;
  chat_id: string;
  session_id: string;
  created_at: number;
  last_used_at: number;
  turn_count: number;
}

function rowToSession(row: Row): ChatSession {
  return {
    service: row.service as ServiceName,
    profile: row.profile,
    chatId: row.chat_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    turnCount: row.turn_count,
  };
}

export function getChatSession(
  db: Database,
  service: ServiceName,
  profile: string,
  chatId: string,
): ChatSession | null {
  const row = db
    .query('SELECT * FROM chat_sessions WHERE service = ? AND profile = ? AND chat_id = ?')
    .get(service, profile, chatId) as Row | null;
  return row ? rowToSession(row) : null;
}

export function upsertChatSession(
  db: Database,
  args: { service: ServiceName; profile: string; chatId: string; sessionId: string; now: number },
): void {
  db.run(
    `INSERT INTO chat_sessions (service, profile, chat_id, session_id, created_at, last_used_at, turn_count)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(service, profile, chat_id) DO UPDATE SET
       session_id = excluded.session_id,
       last_used_at = excluded.last_used_at`,
    [args.service, args.profile, args.chatId, args.sessionId, args.now, args.now],
  );
}

export function bumpChatSessionUsage(
  db: Database,
  service: ServiceName,
  profile: string,
  chatId: string,
  now: number,
): void {
  db.run(
    `UPDATE chat_sessions SET turn_count = turn_count + 1, last_used_at = ?
     WHERE service = ? AND profile = ? AND chat_id = ?`,
    [now, service, profile, chatId],
  );
}
