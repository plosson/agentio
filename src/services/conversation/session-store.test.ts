import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createChatSessionsTable,
  getChatSession,
  upsertChatSession,
  bumpChatSessionUsage,
} from './session-store';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  createChatSessionsTable(db);
});
afterEach(() => { db.close(); });

describe('chat_sessions', () => {
  test('getChatSession returns null when missing', () => {
    expect(getChatSession(db, 'telegram', 'p1', 'chat-1')).toBeNull();
  });

  test('upsertChatSession inserts a new session', () => {
    upsertChatSession(db, {
      service: 'telegram', profile: 'p1', chatId: 'chat-1', sessionId: 'sess-1', now: 1000,
    });
    const row = getChatSession(db, 'telegram', 'p1', 'chat-1');
    expect(row?.sessionId).toBe('sess-1');
    expect(row?.createdAt).toBe(1000);
    expect(row?.lastUsedAt).toBe(1000);
    expect(row?.turnCount).toBe(0);
  });

  test('upsertChatSession replaces session_id (e.g. after compact)', () => {
    upsertChatSession(db, { service: 'telegram', profile: 'p1', chatId: 'chat-1', sessionId: 'sess-1', now: 1000 });
    upsertChatSession(db, { service: 'telegram', profile: 'p1', chatId: 'chat-1', sessionId: 'sess-2', now: 2000 });
    const row = getChatSession(db, 'telegram', 'p1', 'chat-1');
    expect(row?.sessionId).toBe('sess-2');
    expect(row?.createdAt).toBe(1000);  // preserved
    expect(row?.lastUsedAt).toBe(2000);
  });

  test('bumpChatSessionUsage increments turn_count and lastUsedAt', () => {
    upsertChatSession(db, { service: 'telegram', profile: 'p1', chatId: 'chat-1', sessionId: 'sess-1', now: 1000 });
    bumpChatSessionUsage(db, 'telegram', 'p1', 'chat-1', 5000);
    bumpChatSessionUsage(db, 'telegram', 'p1', 'chat-1', 6000);
    const row = getChatSession(db, 'telegram', 'p1', 'chat-1');
    expect(row?.turnCount).toBe(2);
    expect(row?.lastUsedAt).toBe(6000);
  });

  test('different (service, profile, chatId) tuples are isolated', () => {
    upsertChatSession(db, { service: 'telegram', profile: 'p1', chatId: 'a', sessionId: 's-a', now: 1 });
    upsertChatSession(db, { service: 'telegram', profile: 'p1', chatId: 'b', sessionId: 's-b', now: 2 });
    upsertChatSession(db, { service: 'whatsapp', profile: 'p1', chatId: 'a', sessionId: 's-c', now: 3 });
    expect(getChatSession(db, 'telegram', 'p1', 'a')?.sessionId).toBe('s-a');
    expect(getChatSession(db, 'telegram', 'p1', 'b')?.sessionId).toBe('s-b');
    expect(getChatSession(db, 'whatsapp', 'p1', 'a')?.sessionId).toBe('s-c');
  });
});
