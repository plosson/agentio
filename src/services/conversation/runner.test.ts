import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runConversation, type RunConversationDeps } from './runner';
import { createChatSessionsTable, getChatSession, upsertChatSession } from './session-store';
import type { Spawner } from '../claude/runner';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): void {}
}

function makeSpawner(stdoutLines: string[], exitCode = 0): Spawner {
  return () => {
    const child = new FakeChild();
    setImmediate(() => {
      for (const l of stdoutLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      child.emit('close', exitCode);
    });
    return child as unknown as ReturnType<Spawner>;
  };
}

let db: Database;
let logDir: string;
let outboxRows: Array<{ service: string; profile: string; conversationId: string; content: string }>;
let ackedIds: string[];

beforeEach(() => {
  db = new Database(':memory:');
  createChatSessionsTable(db);
  logDir = mkdtempSync(join(tmpdir(), 'agentio-bot-'));
  outboxRows = [];
  ackedIds = [];
});
afterEach(() => {
  db.close();
  rmSync(logDir, { recursive: true, force: true });
});

function deps(spawner: Spawner): RunConversationDeps {
  return {
    db,
    claudePath: '/fake/claude',
    spawner,
    logDir,
    insertOutbox: (msg) => { outboxRows.push(msg); return 'outbox-' + outboxRows.length; },
    markInboxDone: (id) => { ackedIds.push(id); },
    now: () => 1000,
  };
}

const baseInput = {
  service: 'telegram' as const,
  profile: 'p1',
  chatId: 'chat-123',
  inboxId: 'inbox-1',
  message: 'hello bot',
  bot: { enabled: true, model: 'sonnet' as const, permissionMode: 'bypassPermissions' as const },
};

describe('runConversation', () => {
  test('first message: creates session, queues reply, acks inbox', async () => {
    const spawner = makeSpawner([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'result', result: 'hi human' }),
    ]);
    await runConversation(baseInput, deps(spawner));

    expect(getChatSession(db, 'telegram', 'p1', 'chat-123')?.sessionId).toBe('sess-1');
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].content).toBe('hi human');
    expect(outboxRows[0].conversationId).toBe('chat-123');
    expect(ackedIds).toEqual(['inbox-1']);
  });

  test('subsequent message: passes --resume with stored session id', async () => {
    upsertChatSession(db, { service: 'telegram', profile: 'p1', chatId: 'chat-123', sessionId: 'sess-existing', now: 500 });

    let captured: string[] = [];
    const spawner: Spawner = (_cmd, args) => {
      captured = args;
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'reply' }) + '\n'));
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<Spawner>;
    };

    await runConversation(baseInput, deps(spawner));

    const idx = captured.indexOf('--resume');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(captured[idx + 1]).toBe('sess-existing');
  });

  test('long reply is split into multiple outbox rows', async () => {
    const long = 'x'.repeat(5000);
    const spawner = makeSpawner([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'result', result: long }),
    ]);
    await runConversation(baseInput, deps(spawner));
    expect(outboxRows.length).toBeGreaterThan(1);
    expect(outboxRows.every((r) => r.content.length <= 4096)).toBe(true);
  });

  test('claude failure: no outbox, no ack', async () => {
    const spawner = makeSpawner([], 1);
    await runConversation(baseInput, deps(spawner));
    expect(outboxRows).toEqual([]);
    expect(ackedIds).toEqual([]);
  });

  test('writes a per-chat log file', async () => {
    const spawner = makeSpawner([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ]);
    await runConversation(baseInput, deps(spawner));
    const chatLogDir = join(logDir, 'telegram', 'p1', 'chat-123');
    expect(existsSync(chatLogDir)).toBe(true);
    expect(readdirSync(chatLogDir).length).toBeGreaterThan(0);
  });

  test('falls back to assistantText when no result event is present', async () => {
    const spawner = makeSpawner([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
    ]);
    await runConversation(baseInput, deps(spawner));
    expect(outboxRows[0]?.content).toBe('partial');
  });

  test('forwards bot.systemPrompt as --append-system-prompt', async () => {
    let captured: string[] = [];
    const spawner: Spawner = (_cmd, args) => {
      captured = args;
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'ok' }) + '\n'));
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<Spawner>;
    };

    await runConversation(
      { ...baseInput, bot: { ...baseInput.bot, systemPrompt: 'Be concise.' } },
      deps(spawner),
    );

    const idx = captured.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(captured[idx + 1]).toBe('Be concise.');
  });
});
