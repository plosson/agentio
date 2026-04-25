import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { Database } from 'bun:sqlite';
import type { ServiceName } from '../../types/config';
import type { BotConfig } from '../../types/bot';
import { executeClaude, type Spawner } from '../claude/runner';
import { shellEnv } from '../claude/claude-binary';
import {
  getChatSession,
  upsertChatSession,
  bumpChatSessionUsage,
} from './session-store';
import { splitReply } from './reply-splitter';

const TELEGRAM_LIMIT = 4096;
const WHATSAPP_LIMIT = 65536;
const DEFAULT_LIMIT = 4096;

function limitFor(service: ServiceName): number {
  if (service === 'telegram') return TELEGRAM_LIMIT;
  if (service === 'whatsapp') return WHATSAPP_LIMIT;
  return DEFAULT_LIMIT;
}

export interface RunConversationInput {
  service: ServiceName;
  profile: string;
  chatId: string;
  inboxId: string;
  message: string;
  bot: BotConfig;
}

export interface RunConversationDeps {
  db: Database;
  claudePath: string;
  spawner?: Spawner;
  logDir: string;
  insertOutbox: (msg: {
    service: ServiceName;
    profile: string;
    conversationId: string;
    content: string;
  }) => string;
  markInboxDone: (inboxId: string) => void;
  now?: () => number;
}

export async function runConversation(
  input: RunConversationInput,
  deps: RunConversationDeps,
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const ts = new Date(now()).toISOString().replace(/[:]/g, '-');
  const chatLogDir = join(deps.logDir, input.service, input.profile, input.chatId);
  await mkdir(chatLogDir, { recursive: true });
  const logPath = join(chatLogDir, `${ts}.log`);

  const env = { ...shellEnv() } as Record<string, string>;
  delete env.CLAUDECODE;

  const existing = getChatSession(deps.db, input.service, input.profile, input.chatId);
  const cwd = input.bot.cwd ?? process.cwd();

  await appendFile(
    logPath,
    `[${new Date(now()).toISOString()}] inbox=${input.inboxId} session=${existing?.sessionId ?? '(new)'} model=${input.bot.model}\n`,
  );

  const pendingWrites: Promise<unknown>[] = [];
  const result = await executeClaude({
    claudePath: deps.claudePath,
    promptBody: input.message,
    model: input.bot.model,
    permissionMode: input.bot.permissionMode,
    env,
    cwd,
    spawner: deps.spawner,
    resumeSessionId: existing?.sessionId,
    appendSystemPrompt: input.bot.systemPrompt,
    onStdout: (chunk) => { pendingWrites.push(appendFile(logPath, chunk)); },
    onStderr: (chunk) => { pendingWrites.push(appendFile(logPath, chunk)); },
  });

  await Promise.all(pendingWrites);

  await appendFile(
    logPath,
    `\n[${new Date(now()).toISOString()}] exit=${result.exitCode} sessionId=${result.sessionId ?? '(none)'}\n`,
  );

  if (result.sessionId) {
    upsertChatSession(deps.db, {
      service: input.service, profile: input.profile, chatId: input.chatId,
      sessionId: result.sessionId, now: now(),
    });
  }

  if (result.exitCode !== 0) {
    return;  // No reply on failure; inbox row stays pending for inspection.
  }

  const replyText = (result.resultText ?? result.assistantText ?? '').trim();
  if (!replyText) {
    deps.markInboxDone(input.inboxId);
    return;
  }

  const chunks = splitReply(replyText, limitFor(input.service));
  for (const chunk of chunks) {
    deps.insertOutbox({
      service: input.service,
      profile: input.profile,
      conversationId: input.chatId,
      content: chunk,
    });
  }

  bumpChatSessionUsage(deps.db, input.service, input.profile, input.chatId, now());
  deps.markInboxDone(input.inboxId);
}
