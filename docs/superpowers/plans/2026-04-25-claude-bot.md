# Claude Bot (Inbound → Claude) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an inbound message arrives on a bot-enabled profile (Telegram first, generic for any daemon adapter), spawn `claude` with a per-conversation persistent session, route the assistant reply back through the existing outbox, and serialize messages per-conversation so concurrent inputs cannot corrupt the session.

**Architecture:** Extract a generic `executeClaude()` primitive from the existing `runSchedule()` so both schedules and inbound messages share the same spawn/parse/log code. Add a `chat_sessions` table in `daemon.db` keyed by `(service, profile, chat_id)` to store the Claude `session_id` (created from the first message's `system/init` event, then reused via `--resume` on every subsequent message). Add a per-key Promise-chain queue (claudeclaw pattern) keyed by `(service, profile, chat_id)` so messages within a chat run serially while different chats run in parallel. Reply text is split into Telegram-safe chunks and queued into the existing `outbox` table — the daemon's outbox processor handles delivery via the adapter's existing `send()` path. No new send code; conversation runner writes to outbox, outbox processor sends.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun:test`, `child_process.spawn`, Claude CLI (`claude --print --output-format stream-json --verbose --resume <id>`), existing daemon adapters (Telegram via Bot API long-poll).

**Design parallels with `runSchedule`:**

| Concern | Schedule (`runSchedule`) | Bot (`runConversation`) |
|---|---|---|
| Trigger | scheduler tick (cron) | `handleInboundMessage()` |
| Prompt source | `.run.md` body | inbox row `content` |
| Session storage | `state.json` keyed by schedule `id` | `chat_sessions` table keyed by `(service, profile, chat_id)` |
| Concurrency | `inFlight` set (drop if running) | per-key Promise queue (queue if running) |
| Output sink | `.agentio/runs/<id>/<ts>.log` | `~/.config/agentio/bot-runs/<service>/<profile>/<chatId>/<ts>.log` |
| Result routing | none (logs only) | reply text → outbox → adapter `send()` |
| Shared core | `executeClaude()` (extracted) | `executeClaude()` (shared) |

---

## File Structure

### New files

- `src/services/claude/runner.ts` — `executeClaude(opts)`: pure spawn + stream-json parse + log tee, no log-file management, no state.
- `src/services/claude/runner.test.ts` — TDD tests with `FakeChild` spawner.
- `src/services/claude/stream-parser.ts` — pure `parseStreamLine()` extracting `session_id`, `assistant_text`, `result_text` from one JSONL line.
- `src/services/claude/stream-parser.test.ts` — pure-function tests.
- `src/services/claude/claude-binary.ts` — moved from `src/services/schedule/claude-binary.ts` (still exports `locateClaude`, `shellEnv`).
- `src/services/conversation/runner.ts` — `runConversation({service, profile, chatId, message})` orchestrator: lookup-or-create session, call `executeClaude`, split reply, write to outbox, ack inbox.
- `src/services/conversation/runner.test.ts` — TDD with FakeChild + in-memory DB.
- `src/services/conversation/session-store.ts` — CRUD on `chat_sessions` table.
- `src/services/conversation/session-store.test.ts`
- `src/services/conversation/queue.ts` — per-key Promise-chain queue.
- `src/services/conversation/queue.test.ts`
- `src/services/conversation/reply-splitter.ts` — split long text into ≤4096-char chunks at paragraph/sentence boundaries.
- `src/services/conversation/reply-splitter.test.ts`
- `src/types/bot.ts` — `BotConfig` interface.

### Modified files

- `src/services/schedule/runner.ts` — replace inlined spawn+parse with a call to `executeClaude` from the new shared module. Keep current public API and tests.
- `src/services/schedule/runner.test.ts` — no changes; existing tests must still pass.
- `src/types/config.ts` — extend `ProfileEntry` with optional `bot?: BotConfig`. Add `BotConfig` re-export from `./bot`.
- `src/config/config-manager.ts` — `setProfile` accepts `bot` option; reject `bot.enabled=true` together with `readOnly=true`.
- `src/daemon/store.ts` — add `chat_sessions` table creation in `initDatabase`, plus `markInboxDone(id)` helper if not present.
- `src/daemon/daemon.ts` — `handleInboundMessage` looks up bot config; if enabled and message is from a non-bot sender, enqueue `runConversation`. Imports the queue + runner.
- `src/commands/telegram.ts` — add `agentio telegram profile bot enable|disable|show` subcommands.
- `CLAUDE.md` — document the bot feature in the Telegram and Daemon sections.

### Imports broken by the move of `claude-binary.ts`

Only one file imports it today: `src/services/schedule/runner.ts`. That import path changes in Task 1.

---

## Task 1: Move `claude-binary.ts` to shared `services/claude/`

**Files:**
- Move (git mv): `src/services/schedule/claude-binary.ts` → `src/services/claude/claude-binary.ts`
- Modify: `src/services/schedule/runner.ts:5` — update import path

- [ ] **Step 1: Create directory and move file**

```bash
mkdir -p src/services/claude
git mv src/services/schedule/claude-binary.ts src/services/claude/claude-binary.ts
```

- [ ] **Step 2: Update the one import in `runner.ts`**

Edit `src/services/schedule/runner.ts` line 5:

Replace:
```ts
import { shellEnv, locateClaude } from './claude-binary';
```

With:
```ts
import { shellEnv, locateClaude } from '../claude/claude-binary';
```

- [ ] **Step 3: Verify nothing else imports the old path**

```bash
bun run typecheck
```

Expected: PASS (no errors).

```bash
bun test src/services/schedule/runner.test.ts
```

Expected: PASS (all existing tests still green).

- [ ] **Step 4: Commit**

```bash
git add src/services/claude/claude-binary.ts src/services/schedule/runner.ts
git commit -m "refactor: move claude-binary.ts to shared services/claude/"
```

---

## Task 2: Pure stream-json line parser

**Files:**
- Create: `src/services/claude/stream-parser.ts`
- Create: `src/services/claude/stream-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/claude/stream-parser.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseStreamLine } from './stream-parser';

describe('parseStreamLine', () => {
  test('extracts session_id from system/init event', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    expect(parseStreamLine(line)).toEqual({ kind: 'init', sessionId: 'abc-123' });
  });

  test('extracts assistant text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash' }] },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'assistant_text', text: 'hello' });
  });

  test('extracts final result text', () => {
    const line = JSON.stringify({ type: 'result', result: 'final reply' });
    expect(parseStreamLine(line)).toEqual({ kind: 'result', text: 'final reply' });
  });

  test('returns null for unknown event types', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'whatever' }))).toBeNull();
  });

  test('returns null for non-JSON input', () => {
    expect(parseStreamLine('not json')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseStreamLine('')).toBeNull();
  });

  test('ignores assistant event with no text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    });
    expect(parseStreamLine(line)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test src/services/claude/stream-parser.test.ts
```

Expected: FAIL with "Cannot find module './stream-parser'".

- [ ] **Step 3: Write minimal implementation**

Create `src/services/claude/stream-parser.ts`:

```ts
export type StreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'result'; text: string };

interface AnyJson { [k: string]: unknown }

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: AnyJson;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
    return { kind: 'init', sessionId: obj.session_id };
  }

  if (obj.type === 'assistant') {
    const msg = obj.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    const blocks = msg?.content ?? [];
    const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text!);
    if (texts.length > 0) return { kind: 'assistant_text', text: texts.join('') };
    return null;
  }

  if (obj.type === 'result' && typeof obj.result === 'string') {
    return { kind: 'result', text: obj.result };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/services/claude/stream-parser.test.ts
```

Expected: PASS (all 7 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/claude/stream-parser.ts src/services/claude/stream-parser.test.ts
git commit -m "feat(claude): add pure stream-json line parser"
```

---

## Task 3: Generic `executeClaude` primitive

**Files:**
- Create: `src/services/claude/runner.ts`
- Create: `src/services/claude/runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/claude/runner.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { executeClaude, type Spawner } from './runner';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): void {}
}

function makeSpawner(stdoutLines: string[], exitCode: number, stderrLines: string[] = []): {
  spawner: Spawner;
  capturedArgs: { cmd: string; args: string[] };
} {
  const captured = { cmd: '', args: [] as string[] };
  const spawner: Spawner = (cmd, args) => {
    captured.cmd = cmd;
    captured.args = args;
    const child = new FakeChild();
    setImmediate(() => {
      for (const l of stdoutLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      for (const l of stderrLines) child.stderr.emit('data', Buffer.from(l + '\n'));
      child.emit('close', exitCode);
    });
    return child as unknown as ReturnType<Spawner>;
  };
  return { spawner, capturedArgs: captured };
}

describe('executeClaude', () => {
  test('passes prompt + model + permission flags', async () => {
    const { spawner, capturedArgs } = makeSpawner([], 0);
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      env: { PATH: '/usr/bin' },
      cwd: '/tmp',
      spawner,
    });
    expect(capturedArgs.cmd).toBe('/fake/claude');
    expect(capturedArgs.args).toContain('--print');
    expect(capturedArgs.args).toContain('--output-format');
    expect(capturedArgs.args).toContain('stream-json');
    expect(capturedArgs.args).toContain('--verbose');
    expect(capturedArgs.args).toContain('--model');
    expect(capturedArgs.args).toContain('sonnet');
    expect(capturedArgs.args).toContain('--dangerously-skip-permissions');
    expect(capturedArgs.args[capturedArgs.args.length - 1]).toBe('hi');
  });

  test('adds --resume when resumeSessionId given', async () => {
    const { spawner, capturedArgs } = makeSpawner([], 0);
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
      resumeSessionId: 'sess-xyz',
    });
    const idx = capturedArgs.args.indexOf('--resume');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs.args[idx + 1]).toBe('sess-xyz');
  });

  test('captures session_id from system/init event', async () => {
    const { spawner } = makeSpawner(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ],
      0,
    );
    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe('sess-1');
  });

  test('accumulates assistant text across multiple events', async () => {
    const { spawner } = makeSpawner(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'foo ' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'bar' }] } }),
        JSON.stringify({ type: 'result', result: 'foo bar' }),
      ],
      0,
    );
    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.assistantText).toBe('foo bar');
    expect(result.resultText).toBe('foo bar');
  });

  test('calls onStdout with each chunk for log tee', async () => {
    const { spawner } = makeSpawner(['hello', 'world'], 0);
    const chunks: string[] = [];
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
      onStdout: (c) => chunks.push(c),
    });
    expect(chunks.join('')).toContain('hello');
    expect(chunks.join('')).toContain('world');
  });

  test('non-zero exit code is propagated', async () => {
    const { spawner } = makeSpawner([], 7);
    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.exitCode).toBe(7);
  });

  test('appends --append-system-prompt when given', async () => {
    const { spawner, capturedArgs } = makeSpawner([], 0);
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
      appendSystemPrompt: 'You are helpful.',
    });
    const idx = capturedArgs.args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs.args[idx + 1]).toBe('You are helpful.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test src/services/claude/runner.test.ts
```

Expected: FAIL with "Cannot find module './runner'".

- [ ] **Step 3: Write minimal implementation**

Create `src/services/claude/runner.ts`:

```ts
import { spawn, type ChildProcess } from 'child_process';
import type { Model, PermissionMode } from '../../types/schedule';
import { parseStreamLine } from './stream-parser';

export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface ExecuteClaudeOpts {
  claudePath: string;
  promptBody: string;
  model: Model;
  permissionMode: PermissionMode;
  env: Record<string, string>;
  cwd: string;
  resumeSessionId?: string;
  appendSystemPrompt?: string;
  spawner?: Spawner;
  /** Called for every raw stdout chunk (e.g., to tee into a log file). */
  onStdout?: (chunk: string) => void;
  /** Called for every raw stderr chunk. */
  onStderr?: (chunk: string) => void;
}

export interface ExecuteClaudeResult {
  exitCode: number;
  sessionId?: string;
  /** Concatenated text from all assistant text blocks. */
  assistantText: string;
  /** Final `result` event text (Claude's official end-of-turn output). */
  resultText?: string;
}

function buildArgs(opts: ExecuteClaudeOpts): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', opts.model];

  switch (opts.permissionMode) {
    case 'bypassPermissions': args.push('--dangerously-skip-permissions'); break;
    case 'plan':              args.push('--permission-mode', 'plan'); break;
    case 'acceptEdits':       args.push('--permission-mode', 'acceptEdits'); break;
    case 'default':           break;
  }

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }

  if (opts.appendSystemPrompt) {
    args.push('--append-system-prompt', opts.appendSystemPrompt);
  }

  args.push(opts.promptBody);
  return args;
}

export async function executeClaude(opts: ExecuteClaudeOpts): Promise<ExecuteClaudeResult> {
  const spawner = opts.spawner ?? (spawn as Spawner);
  const args = buildArgs(opts);
  const child = spawner(opts.claudePath, args, { cwd: opts.cwd, env: opts.env });

  let sessionId: string | undefined;
  let assistantText = '';
  let resultText: string | undefined;
  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    if (opts.onStdout) opts.onStdout(text);
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const ev = parseStreamLine(line);
      if (!ev) continue;
      if (ev.kind === 'init') sessionId = ev.sessionId;
      else if (ev.kind === 'assistant_text') assistantText += ev.text;
      else if (ev.kind === 'result') resultText = ev.text;
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (opts.onStderr) opts.onStderr(chunk.toString('utf-8'));
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  return { exitCode, sessionId, assistantText, resultText };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/services/claude/runner.test.ts
```

Expected: PASS (all 7 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/claude/runner.ts src/services/claude/runner.test.ts
git commit -m "feat(claude): add generic executeClaude primitive"
```

---

## Task 4: Refactor `runSchedule` to use `executeClaude`

**Files:**
- Modify: `src/services/schedule/runner.ts`

The goal is to replace the inlined spawn/parse/buffer logic in `runSchedule` with a call to the shared `executeClaude` primitive, while keeping the public API and existing tests untouched.

- [ ] **Step 1: Verify existing tests are green before refactor**

```bash
bun test src/services/schedule/runner.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 2: Refactor `runSchedule`**

Edit `src/services/schedule/runner.ts`. Replace the entire file content with:

```ts
import { spawn, type ChildProcess } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FrontmatterConfig } from '../../types/schedule';
import { shellEnv, locateClaude } from '../claude/claude-binary';
import { executeClaude } from '../claude/runner';
import { updateState } from './state';

export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface RunScheduleOpts {
  folder: string;
  id: string;
  promptBody: string;
  config: FrontmatterConfig;
  /** When false, tee child stdout/stderr to process.stdout/stderr. Defaults to true. */
  quiet?: boolean;
  spawner?: Spawner;
  claudePath?: string | null;
  now?: () => Date;
  stdout?: { write: (chunk: string | Buffer) => boolean };
  stderr?: { write: (chunk: string | Buffer) => boolean };
}

export interface RunResult {
  exitCode: number;
  logPath: string;
  sessionId?: string;
}

export async function runSchedule(opts: RunScheduleOpts): Promise<RunResult> {
  const now = (opts.now ?? (() => new Date()))();
  const runsDir = join(opts.folder, '.agentio', 'runs', opts.id);
  await mkdir(runsDir, { recursive: true });
  const ts = now.toISOString().replace(/[:]/g, '-');
  const logPath = join(runsDir, `${ts}.log`);

  const spawner = opts.spawner ?? (spawn as Spawner);
  const env = { ...shellEnv() } as Record<string, string>;
  delete env.CLAUDECODE;

  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const tee = opts.quiet === false;

  // Shell-command override: keep the existing path (not Claude).
  if (opts.config.command) {
    return runShellCommand({ cmd: '/bin/zsh', args: ['-lic', opts.config.command],
      logPath, spawner, env, cwd: opts.folder, tee, stdout, stderr, now });
  }

  const claude = opts.claudePath ?? locateClaude();
  if (!claude) {
    await appendFile(logPath,
      'ERROR: claude CLI not found. Tried PATH + ~/.claude/local/bin, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.\n');
    await writeSummary(logPath, { status: 'failed', exitCode: 127, startedAt: now, endedAt: new Date() });
    return { exitCode: 127, logPath };
  }

  const spawnLine =
    `[${now.toISOString()}] spawn: ${claude} (model=${opts.config.model}, perm=${opts.config.permissionMode})\n`;
  await appendFile(logPath, spawnLine);
  if (tee) stderr.write(spawnLine);

  const pendingWrites: Promise<unknown>[] = [];
  const result = await executeClaude({
    claudePath: claude,
    promptBody: opts.promptBody,
    model: opts.config.model,
    permissionMode: opts.config.permissionMode,
    env,
    cwd: opts.folder,
    spawner,
    onStdout: (chunk) => {
      if (tee) stdout.write(chunk);
      pendingWrites.push(appendFile(logPath, chunk));
    },
    onStderr: (chunk) => {
      if (tee) stderr.write(chunk);
      pendingWrites.push(appendFile(logPath, chunk));
    },
  });

  await Promise.all(pendingWrites);

  if (result.sessionId) {
    await updateState(opts.folder, opts.id, { sessionId: result.sessionId });
  }

  const endedAt = new Date();
  const status = result.exitCode === 0 ? 'succeeded' : 'failed';
  await writeSummary(logPath, {
    status, exitCode: result.exitCode, sessionId: result.sessionId, startedAt: now, endedAt,
  });
  await updateState(opts.folder, opts.id, {
    lastRunAt: endedAt.toISOString(),
    lastExitCode: result.exitCode,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
  });

  return { exitCode: result.exitCode, logPath, sessionId: result.sessionId };
}

interface RunShellOpts {
  cmd: string;
  args: string[];
  logPath: string;
  spawner: Spawner;
  env: Record<string, string>;
  cwd: string;
  tee: boolean;
  stdout: { write: (chunk: string | Buffer) => boolean };
  stderr: { write: (chunk: string | Buffer) => boolean };
  now: Date;
}

async function runShellCommand(o: RunShellOpts): Promise<RunResult> {
  const spawnLine = `[${o.now.toISOString()}] spawn: ${o.cmd} ${o.args.map((a) => JSON.stringify(a)).join(' ')}\n`;
  await appendFile(o.logPath, spawnLine);
  if (o.tee) o.stderr.write(spawnLine);

  const child = o.spawner(o.cmd, o.args, { cwd: o.cwd, env: o.env });
  const pending: Promise<unknown>[] = [];
  child.stdout?.on('data', (c: Buffer) => {
    if (o.tee) o.stdout.write(c);
    pending.push(appendFile(o.logPath, c.toString('utf-8')));
  });
  child.stderr?.on('data', (c: Buffer) => {
    if (o.tee) o.stderr.write(c);
    pending.push(appendFile(o.logPath, c.toString('utf-8')));
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });
  await Promise.all(pending);

  const endedAt = new Date();
  const status = exitCode === 0 ? 'succeeded' : 'failed';
  await writeSummary(o.logPath, { status, exitCode, startedAt: o.now, endedAt });
  return { exitCode, logPath: o.logPath };
}

async function writeSummary(logPath: string, fields: {
  status: string; exitCode: number; sessionId?: string; startedAt: Date; endedAt: Date;
}): Promise<void> {
  const summary = {
    type: 'summary',
    status: fields.status,
    exitCode: fields.exitCode,
    durationMs: fields.endedAt.getTime() - fields.startedAt.getTime(),
    sessionId: fields.sessionId,
    startedAt: fields.startedAt.toISOString(),
    endedAt: fields.endedAt.toISOString(),
  };
  await appendFile(logPath, '\n' + JSON.stringify(summary) + '\n');
}
```

- [ ] **Step 3: Run existing tests to verify they still pass**

```bash
bun test src/services/schedule/runner.test.ts
```

Expected: PASS (all 5 tests green — same behavior, new internals).

- [ ] **Step 4: Run full typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/schedule/runner.ts
git commit -m "refactor(schedule): delegate spawn/parse to executeClaude primitive"
```

---

## Task 5: Add `chat_sessions` table + CRUD

**Files:**
- Modify: `src/daemon/store.ts` — add table creation in `initDatabase`.
- Create: `src/services/conversation/session-store.ts`
- Create: `src/services/conversation/session-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/conversation/session-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/conversation/session-store.test.ts
```

Expected: FAIL with "Cannot find module './session-store'".

- [ ] **Step 3: Write minimal implementation**

Create `src/services/conversation/session-store.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/services/conversation/session-store.test.ts
```

Expected: PASS (5 tests green).

- [ ] **Step 5: Wire table creation into daemon store**

Edit `src/daemon/store.ts`. Add at the top of the file:

```ts
import { createChatSessionsTable } from '../services/conversation/session-store';
```

Inside `initDatabase()`, after the existing `CREATE TABLE IF NOT EXISTS whatsapp_auth_keys` block and the `CREATE INDEX IF NOT EXISTS idx_whatsapp_keys` line, add:

```ts
  // Conversation bot session tracking
  createChatSessionsTable(db);
```

- [ ] **Step 6: Verify daemon initializes without errors**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/conversation/session-store.ts src/services/conversation/session-store.test.ts src/daemon/store.ts
git commit -m "feat(conversation): add chat_sessions table for per-chat Claude sessions"
```

---

## Task 6: Per-key serial queue utility

**Files:**
- Create: `src/services/conversation/queue.ts`
- Create: `src/services/conversation/queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/conversation/queue.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { SerialQueue } from './queue';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('SerialQueue', () => {
  test('runs tasks for the same key in submission order', async () => {
    const q = new SerialQueue<string>();
    const order: string[] = [];
    const a = deferred<void>();
    const b = deferred<void>();

    const p1 = q.enqueue('chat-1', async () => { await a.promise; order.push('A'); });
    const p2 = q.enqueue('chat-1', async () => { await b.promise; order.push('B'); });

    // Resolve B first, but A was queued first — A still must run first.
    b.resolve(); a.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['A', 'B']);
  });

  test('runs tasks for different keys in parallel', async () => {
    const q = new SerialQueue<string>();
    const a = deferred<void>();
    const b = deferred<void>();

    const p1 = q.enqueue('chat-1', async () => { await a.promise; return 'A'; });
    const p2 = q.enqueue('chat-2', async () => { await b.promise; return 'B'; });

    // Both can be in-flight: resolve B first, p2 finishes before p1.
    b.resolve();
    expect(await p2).toBe('B');
    a.resolve();
    expect(await p1).toBe('A');
  });

  test('a thrown task does not stall the queue for that key', async () => {
    const q = new SerialQueue<string>();
    const p1 = q.enqueue('chat-1', async () => { throw new Error('boom'); });
    const p2 = q.enqueue('chat-1', async () => 'next');
    await expect(p1).rejects.toThrow('boom');
    expect(await p2).toBe('next');
  });

  test('returns task result via the promise', async () => {
    const q = new SerialQueue<string>();
    const result = await q.enqueue('k', async () => 42);
    expect(result).toBe(42);
  });

  test('size() reflects pending keys', async () => {
    const q = new SerialQueue<string>();
    const d = deferred<void>();
    q.enqueue('k', async () => { await d.promise; });
    expect(q.size()).toBe(1);
    d.resolve();
    // Wait one microtask for the chain cleanup.
    await new Promise((r) => setImmediate(r));
    expect(q.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/conversation/queue.test.ts
```

Expected: FAIL with "Cannot find module './queue'".

- [ ] **Step 3: Write minimal implementation**

Create `src/services/conversation/queue.ts`:

```ts
/**
 * Per-key serial queue. Tasks submitted under the same key run strictly in order;
 * tasks under different keys run in parallel. Pattern adapted from claudeclaw's
 * `enqueue()` — required to prevent concurrent `claude --resume <id>` from
 * corrupting the same on-disk session file.
 */
export class SerialQueue<K> {
  private tails: Map<K, Promise<unknown>> = new Map();

  enqueue<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous.then(fn, fn);
    const cleanup = task.catch(() => {}).finally(() => {
      // Only clear the tail if no later task chained onto us.
      if (this.tails.get(key) === cleanup) this.tails.delete(key);
    });
    this.tails.set(key, cleanup);
    return task;
  }

  size(): number {
    return this.tails.size;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/services/conversation/queue.test.ts
```

Expected: PASS (5 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation/queue.ts src/services/conversation/queue.test.ts
git commit -m "feat(conversation): add per-key serial queue for chat ordering"
```

---

## Task 7: Reply splitter for long Telegram messages

**Files:**
- Create: `src/services/conversation/reply-splitter.ts`
- Create: `src/services/conversation/reply-splitter.test.ts`

Telegram caps a single `sendMessage` at 4096 chars. Long Claude replies need splitting. WhatsApp has a higher limit (65k) but the same primitive applies.

- [ ] **Step 1: Write the failing test**

Create `src/services/conversation/reply-splitter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { splitReply } from './reply-splitter';

describe('splitReply', () => {
  test('returns input unchanged when under limit', () => {
    expect(splitReply('hello', 4096)).toEqual(['hello']);
  });

  test('empty input returns empty array', () => {
    expect(splitReply('', 4096)).toEqual([]);
    expect(splitReply('   ', 4096)).toEqual([]);
  });

  test('splits at paragraph boundary when possible', () => {
    const a = 'A'.repeat(2000);
    const b = 'B'.repeat(2000);
    const text = `${a}\n\n${b}`;
    const parts = splitReply(text, 3000);
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(a);
    expect(parts[1]).toBe(b);
  });

  test('splits at sentence boundary when no paragraph break', () => {
    const a = 'A'.repeat(1500) + '.';
    const b = ' ' + 'B'.repeat(1500) + '.';
    const text = a + b;
    const parts = splitReply(text, 1600);
    expect(parts.length).toBe(2);
    expect(parts[0].endsWith('.')).toBe(true);
  });

  test('hard-splits at limit when no boundary found', () => {
    const text = 'X'.repeat(5000);
    const parts = splitReply(text, 1000);
    expect(parts.length).toBe(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  test('preserves all content across splits', () => {
    const text = 'a'.repeat(300) + '\n\n' + 'b'.repeat(300) + '\n\n' + 'c'.repeat(300);
    const parts = splitReply(text, 400);
    expect(parts.join('')).toBe(text.replace(/\n\n/g, ''));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/conversation/reply-splitter.test.ts
```

Expected: FAIL with "Cannot find module './reply-splitter'".

- [ ] **Step 3: Write minimal implementation**

Create `src/services/conversation/reply-splitter.ts`:

```ts
/**
 * Split text into chunks no larger than `maxChars`, preferring paragraph then
 * sentence boundaries. Whitespace at boundaries is dropped; raw character
 * content within each chunk is preserved.
 */
export function splitReply(input: string, maxChars: number): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);

    let cut = window.lastIndexOf('\n\n');
    if (cut < maxChars * 0.5) cut = -1;  // too early; ignore

    if (cut < 0) {
      const sentence = window.lastIndexOf('. ');
      if (sentence >= maxChars * 0.5) cut = sentence + 1;  // include the period
    }

    if (cut < 0) cut = maxChars;  // hard split

    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  if (remaining.length > 0) out.push(remaining);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/services/conversation/reply-splitter.test.ts
```

Expected: PASS (6 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation/reply-splitter.ts src/services/conversation/reply-splitter.test.ts
git commit -m "feat(conversation): add reply splitter for platform char limits"
```

---

## Task 8: BotConfig types + ProfileEntry extension

**Files:**
- Create: `src/types/bot.ts`
- Modify: `src/types/config.ts` — extend `ProfileEntry`.

- [ ] **Step 1: Write the failing test**

Create `src/types/bot.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { BotConfig } from './bot';
import { DEFAULT_BOT_CONFIG } from './bot';
import type { ProfileEntry } from './config';

describe('BotConfig', () => {
  test('DEFAULT_BOT_CONFIG has bypassPermissions and sonnet', () => {
    expect(DEFAULT_BOT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_BOT_CONFIG.model).toBe('sonnet');
    expect(DEFAULT_BOT_CONFIG.permissionMode).toBe('bypassPermissions');
  });

  test('ProfileEntry accepts optional bot config', () => {
    const entry: ProfileEntry = {
      name: 'mybot',
      bot: { enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions' },
    };
    expect(entry.bot?.enabled).toBe(true);
  });

  test('BotConfig accepts optional systemPrompt and cwd', () => {
    const cfg: BotConfig = {
      enabled: true, model: 'opus', permissionMode: 'plan',
      systemPrompt: 'You are concise.',
      cwd: '/tmp/work',
    };
    expect(cfg.systemPrompt).toBe('You are concise.');
    expect(cfg.cwd).toBe('/tmp/work');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/types/bot.test.ts
```

Expected: FAIL with "Cannot find module './bot'".

- [ ] **Step 3: Create the BotConfig type**

Create `src/types/bot.ts`:

```ts
import type { Model, PermissionMode } from './schedule';

export interface BotConfig {
  /** When false, inbound messages are stored but no Claude is spawned. */
  enabled: boolean;
  /** Claude model to use. */
  model: Model;
  /** Claude permission mode. `bypassPermissions` is required for fully-automated bots. */
  permissionMode: PermissionMode;
  /** Optional content appended via --append-system-prompt on every turn. */
  systemPrompt?: string;
  /** Working directory passed to `claude`. Defaults to ~/.config/agentio/bot-cwd. */
  cwd?: string;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
};
```

- [ ] **Step 4: Extend `ProfileEntry`**

Edit `src/types/config.ts`. Add the import near the top:

```ts
import type { BotConfig } from './bot';
```

Replace the `ProfileEntry` interface:

```ts
export interface ProfileEntry {
  name: string;
  readOnly?: boolean;
  bot?: BotConfig;
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/types/bot.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/bot.ts src/types/bot.test.ts src/types/config.ts
git commit -m "feat(types): add BotConfig and extend ProfileEntry"
```

---

## Task 9: `setProfileBot` config-manager helper

**Files:**
- Modify: `src/config/config-manager.ts` — add `setProfileBot(service, profileName, bot)` and `getProfileBot(service, profileName)`.

The current `setProfile` is in `src/config/config-manager.ts`. We add two new exports without breaking existing call sites.

- [ ] **Step 1: Open `config-manager.ts` and identify where `setProfile` is defined**

```bash
bun --bun grep -n "export async function setProfile" src/config/config-manager.ts
```

Note the line range so the new functions can sit alongside it.

- [ ] **Step 2: Write a failing test**

Create `src/config/config-manager.bot.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { CliError } from '../utils/errors';

let tempDir: string;
let configManager: typeof import('./config-manager');

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agentio-cfg-'));
  process.env.AGENTIO_CONFIG_DIR = tempDir;
  // Re-import to pick up the env override.
  configManager = await import('./config-manager?bust=' + Math.random());
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AGENTIO_CONFIG_DIR;
});

describe('setProfileBot', () => {
  test('stores bot config alongside the profile', async () => {
    await configManager.setProfile('telegram', 'p1');
    await configManager.setProfileBot('telegram', 'p1', {
      enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions',
    });
    const cfg = await configManager.getProfileBot('telegram', 'p1');
    expect(cfg?.enabled).toBe(true);
  });

  test('rejects bot.enabled=true on read-only profile', async () => {
    await configManager.setProfile('telegram', 'p1', { readOnly: true });
    await expect(
      configManager.setProfileBot('telegram', 'p1', {
        enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions',
      }),
    ).rejects.toThrow(CliError);
  });

  test('returns undefined for profile with no bot config', async () => {
    await configManager.setProfile('telegram', 'p1');
    expect(await configManager.getProfileBot('telegram', 'p1')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test src/config/config-manager.bot.test.ts
```

Expected: FAIL — `setProfileBot` / `getProfileBot` not exported.

- [ ] **Step 4: Implement the helpers**

In `src/config/config-manager.ts`, after the existing `setProfile` function, add:

```ts
import type { BotConfig } from '../types/bot';
import type { ServiceName, ProfileEntry } from '../types/config';
import { CliError } from '../utils/errors';

export async function setProfileBot(
  service: ServiceName,
  profileName: string,
  bot: BotConfig,
): Promise<void> {
  const config = await loadConfig();
  const profiles = (config.profiles[service] ?? []) as ProfileEntry[];
  const idx = profiles.findIndex((p) =>
    typeof p === 'string' ? p === profileName : p.name === profileName,
  );
  if (idx < 0) {
    throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for ${service}`);
  }
  const existing: ProfileEntry =
    typeof profiles[idx] === 'string' ? { name: profiles[idx] as string } : (profiles[idx] as ProfileEntry);
  if (bot.enabled && existing.readOnly) {
    throw new CliError(
      'INVALID_PARAMS',
      'Cannot enable bot on a read-only profile',
      'Remove --read-only or create a new profile.',
    );
  }
  profiles[idx] = { ...existing, bot };
  config.profiles[service] = profiles;
  await saveConfig(config);
}

export async function getProfileBot(
  service: ServiceName,
  profileName: string,
): Promise<BotConfig | undefined> {
  const config = await loadConfig();
  const profiles = (config.profiles[service] ?? []) as ProfileEntry[];
  const entry = profiles.find((p) =>
    typeof p === 'string' ? p === profileName : p.name === profileName,
  );
  if (!entry || typeof entry === 'string') return undefined;
  return entry.bot;
}
```

If `setProfile`, `loadConfig`, or `saveConfig` already exist with similar semantics in this file, **reuse them**. Match imports already in the file rather than duplicating them. The `CliError` and types imports above may already be present at the top of the file — only add what's missing.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test src/config/config-manager.bot.test.ts
```

Expected: PASS (3 tests green).

- [ ] **Step 6: Run full typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/config-manager.ts src/config/config-manager.bot.test.ts
git commit -m "feat(config): add setProfileBot/getProfileBot helpers"
```

---

## Task 10: `runConversation` orchestrator

**Files:**
- Create: `src/services/conversation/runner.ts`
- Create: `src/services/conversation/runner.test.ts`

This is the bot equivalent of `runSchedule`. It looks up the chat session, calls `executeClaude`, splits the reply, writes outbox rows, and acks the inbox.

- [ ] **Step 1: Write the failing test**

Create `src/services/conversation/runner.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/conversation/runner.test.ts
```

Expected: FAIL with "Cannot find module './runner'".

- [ ] **Step 3: Implement `runConversation`**

Create `src/services/conversation/runner.ts`:

```ts
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
    onStdout: (chunk) => { void appendFile(logPath, chunk); },
    onStderr: (chunk) => { void appendFile(logPath, chunk); },
  });

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/services/conversation/runner.test.ts
```

Expected: PASS (6 tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation/runner.ts src/services/conversation/runner.test.ts
git commit -m "feat(conversation): add runConversation orchestrator"
```

---

## Task 11: Wire bot dispatch into `handleInboundMessage`

**Files:**
- Modify: `src/daemon/daemon.ts` — extend `handleInboundMessage` to enqueue `runConversation` when bot is enabled.
- Modify: `src/daemon/store.ts` — ensure `markInboxDone(id)` exists; expose `insertOutboxMessage` for use by the conversation runner.

The existing `handleInboundMessage` (`src/daemon/daemon.ts:38`) currently inserts the inbox row and queues a webhook. We add: after insert, if the message has a sender that isn't the bot itself **and** the profile has `bot.enabled`, enqueue `runConversation`.

- [ ] **Step 1: Confirm `markInboxDone` and `insertOutboxMessage` exist**

```bash
bun --bun grep -n "markInboxDone\|insertOutboxMessage" src/daemon/store.ts
```

If `markInboxDone` does **not** exist, add it after the existing inbox helpers in `src/daemon/store.ts`:

```ts
export function markInboxDone(id: string, now: number = Date.now()): void {
  const db = getDatabase();
  db.run(`UPDATE inbox SET status = 'done', done_at = ? WHERE id = ?`, [now, id]);
}
```

If it exists, no change is needed.

- [ ] **Step 2: Add a singleton `SerialQueue` and dispatch helper at module level in `daemon.ts`**

Edit `src/daemon/daemon.ts`. Add imports near the top, alongside existing imports:

```ts
import { getProfileBot } from '../config/config-manager';
import { runConversation } from '../services/conversation/runner';
import { SerialQueue } from '../services/conversation/queue';
import { locateClaude } from '../services/claude/claude-binary';
import { markInboxDone, insertOutboxMessage, getDatabase } from './store';
```

(Drop any duplicates that are already imported above.)

Add module-level state (place after the existing `let adapters: …` declarations):

```ts
const conversationQueue = new SerialQueue<string>();
const BOT_LOG_DIR = join(CONFIG_DIR, 'bot-runs');
```

- [ ] **Step 3: Modify `handleInboundMessage` to dispatch to the bot**

Replace the body of `handleInboundMessage` (`src/daemon/daemon.ts:38`):

```ts
function handleInboundMessage(service: ServiceName, profile: string, message: AdapterInboundMessage): void {
  // Check for duplicates
  if (inboxMessageExists(service, profile, message.platformId)) {
    return;
  }

  // Insert into inbox
  const inboxMessage = insertInboxMessage({
    service,
    profile,
    conversationId: message.conversationId,
    platformId: message.platformId,
    senderId: message.senderId,
    senderName: message.senderName,
    senderHandle: message.senderHandle,
    content: message.content,
    mediaType: message.mediaType,
    mediaPath: message.mediaUrl,
    receivedAt: message.receivedAt,
    replyToId: message.replyToId,
    metadata: message.metadata,
  });

  console.log(`[inbox] New message: ${service}:${profile} from ${message.senderName || message.senderId}`);

  // Queue webhook notification
  queueWebhookNotification({
    id: inboxMessage.id,
    service,
    profile,
    sender: message.senderName || message.senderHandle || message.senderId,
    preview: (message.content || '[media]').slice(0, 100),
  });

  // Bot dispatch (fire-and-forget, queued per chat)
  void dispatchBot(service, profile, inboxMessage.id, message);
}

async function dispatchBot(
  service: ServiceName,
  profile: string,
  inboxId: string,
  message: AdapterInboundMessage,
): Promise<void> {
  const bot = await getProfileBot(service, profile);
  if (!bot || !bot.enabled) return;
  if (!message.content || !message.content.trim()) return;  // skip media-only

  const claudePath = locateClaude();
  if (!claudePath) {
    console.error('[bot] claude CLI not found; bot disabled at runtime');
    return;
  }

  const key = `${service}:${profile}:${message.conversationId}`;
  conversationQueue.enqueue(key, async () => {
    try {
      await runConversation(
        {
          service,
          profile,
          chatId: message.conversationId,
          inboxId,
          message: message.content!,
          bot,
        },
        {
          db: getDatabase(),
          claudePath,
          logDir: BOT_LOG_DIR,
          insertOutbox: (msg) => insertOutboxMessage({
            service: msg.service,
            profile: msg.profile,
            conversationId: msg.conversationId,
            content: msg.content,
          }).id,
          markInboxDone: (id) => markInboxDone(id),
        },
      );
    } catch (e) {
      console.error(`[bot] runConversation failed for ${key}:`, e instanceof Error ? e.message : e);
    }
  });
}
```

The signature of `insertOutboxMessage` may need a small adjustment. Confirm by reading its existing signature in `src/daemon/store.ts`. The conversation runner passes only `{service, profile, conversationId, content}`; if `insertOutboxMessage` requires more fields (e.g. `queuedAt`), pass them via the wrapper above.

- [ ] **Step 4: Add an integration test**

Create `src/daemon/bot-dispatch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agentio-bot-test-'));
  process.env.AGENTIO_CONFIG_DIR = tempDir;
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AGENTIO_CONFIG_DIR;
});

describe('bot dispatch (integration)', () => {
  test('inbound message on bot-enabled profile produces an outbox row', async () => {
    const { initDatabase, getInboxMessages, getOutboxMessages } = await import('./store');
    const { setProfile } = await import('../config/config-manager');
    const { setProfileBot } = await import('../config/config-manager');
    await initDatabase();
    await setProfile('telegram', 'p1');
    await setProfileBot('telegram', 'p1', {
      enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions',
    });

    // The dispatch path requires a claude binary; skip the actual spawn by
    // stubbing the runner. (Full e2e is covered in conversation/runner.test.ts.)
    // Here we only assert the inbox insert + dedupe behavior is unchanged.
    const { handleInboundMessage } = await import('./daemon-test-helpers');
    handleInboundMessage('telegram', 'p1', {
      conversationId: 'chat-1', platformId: 'plat-1', senderId: 'u1',
      content: 'hi', receivedAt: Date.now(),
    } as any);

    const messages = getInboxMessages({ service: 'telegram', profile: 'p1' });
    expect(messages.length).toBe(1);
  });
});
```

If `daemon-test-helpers` does not exist, instead test by importing `handleInboundMessage` after exporting it. Easier alternative: skip the integration test in this task if the existing daemon test setup is heavy, and rely on the unit tests in Task 10 plus a manual end-to-end run in Task 13.

**Decision rule:** if exporting `handleInboundMessage` cleanly costs more than 30 lines of refactor, drop this integration test from scope and rely on Task 13's manual verification.

- [ ] **Step 5: Run all tests**

```bash
bun test
```

Expected: PASS — all existing tests still green; new tests green.

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/daemon.ts src/daemon/store.ts src/daemon/bot-dispatch.test.ts
git commit -m "feat(daemon): dispatch inbound messages to Claude bot when enabled"
```

---

## Task 12: CLI commands to enable/disable bot per profile

**Files:**
- Modify: `src/commands/telegram.ts` — add `agentio telegram profile bot enable|disable|show` subcommands.

The `profile` command is created by `createProfileCommands(...)`. We add a `.command('bot')` group under it.

- [ ] **Step 1: Locate the profile command group**

The `profile` group is returned from `createProfileCommands` at `src/commands/telegram.ts:76`. After that line and after the existing `profile.command('add')` block (lines 82-93), add a `bot` subcommand group.

- [ ] **Step 2: Add bot subcommands**

Insert after the existing `profile.command('add')` block in `src/commands/telegram.ts`:

```ts
  const botGroup = profile
    .command('bot')
    .description('Configure Claude bot auto-reply for a profile');

  botGroup
    .command('enable')
    .description('Enable Claude auto-reply for inbound messages')
    .option('--profile <name>', 'Profile name')
    .option('--model <model>', 'Claude model (opus|sonnet|haiku)', 'sonnet')
    .option('--permission-mode <mode>', 'Permission mode (default|bypassPermissions|plan|acceptEdits)', 'bypassPermissions')
    .option('--system-prompt <text>', 'Optional --append-system-prompt content')
    .option('--cwd <dir>', 'Working directory for the bot')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No Telegram profiles configured', 'Run: agentio telegram profile add');
          }
          throw multipleProfilesError('telegram', profileResult.names);
        }
        const { setProfileBot } = await import('../config/config-manager');
        await setProfileBot('telegram', profileResult.profile, {
          enabled: true,
          model: options.model,
          permissionMode: options.permissionMode,
          systemPrompt: options.systemPrompt,
          cwd: options.cwd,
        });
        console.log(`Bot enabled for profile "${profileResult.profile}"`);
        console.log(`  Model: ${options.model}`);
        console.log(`  Permission: ${options.permissionMode}`);
        console.log('Restart the daemon to pick up changes: agentio daemon restart');
      } catch (error) {
        handleError(error);
      }
    });

  botGroup
    .command('disable')
    .description('Disable Claude auto-reply for a profile')
    .option('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        if (profileResult.profile === null) throw new CliError('PROFILE_NOT_FOUND', 'No Telegram profiles configured');
        const { setProfileBot, getProfileBot } = await import('../config/config-manager');
        const existing = await getProfileBot('telegram', profileResult.profile);
        await setProfileBot('telegram', profileResult.profile, {
          enabled: false,
          model: existing?.model ?? 'sonnet',
          permissionMode: existing?.permissionMode ?? 'bypassPermissions',
          systemPrompt: existing?.systemPrompt,
          cwd: existing?.cwd,
        });
        console.log(`Bot disabled for profile "${profileResult.profile}"`);
      } catch (error) {
        handleError(error);
      }
    });

  botGroup
    .command('show')
    .description('Show bot configuration for a profile')
    .option('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        if (profileResult.profile === null) throw new CliError('PROFILE_NOT_FOUND', 'No Telegram profiles configured');
        const { getProfileBot } = await import('../config/config-manager');
        const cfg = await getProfileBot('telegram', profileResult.profile);
        if (!cfg) {
          console.log(`No bot configuration for "${profileResult.profile}"`);
          return;
        }
        console.log(`Profile: ${profileResult.profile}`);
        console.log(`  Enabled: ${cfg.enabled}`);
        console.log(`  Model: ${cfg.model}`);
        console.log(`  Permission: ${cfg.permissionMode}`);
        if (cfg.systemPrompt) console.log(`  System prompt: ${cfg.systemPrompt.slice(0, 80)}...`);
        if (cfg.cwd) console.log(`  CWD: ${cfg.cwd}`);
      } catch (error) {
        handleError(error);
      }
    });
```

- [ ] **Step 3: Verify CLI registers correctly**

```bash
bun run dev telegram profile bot --help
```

Expected output: lists `enable`, `disable`, `show` subcommands.

- [ ] **Step 4: Manual smoke test**

```bash
bun run dev telegram profile bot enable --profile <existing-profile>
bun run dev telegram profile bot show --profile <existing-profile>
bun run dev telegram profile bot disable --profile <existing-profile>
```

Expected: each command prints success messages; `show` reflects the latest state.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/telegram.ts
git commit -m "feat(telegram): add profile bot enable/disable/show commands"
```

---

## Task 13: End-to-end manual verification

**Files:** none modified. Manual verification only.

- [ ] **Step 1: Build and restart the daemon**

```bash
bun run build
bun run dev daemon restart
bun run dev daemon status
```

Expected: daemon running; logs show Telegram adapter connected for the profile under test.

- [ ] **Step 2: Enable bot on a test Telegram profile**

```bash
bun run dev telegram profile bot enable --profile <test-profile> --system-prompt "You are a concise test bot."
bun run dev daemon restart
```

- [ ] **Step 3: Send a message to the bot from Telegram**

From your Telegram client, send a message to the channel/chat the bot is in (or DM the bot if it's set up to receive DMs).

Expected: within ~10 seconds, a reply appears in Telegram. Tail the log:

```bash
bun run dev daemon logs --follow
```

You should see `[bot]` lines, a spawn of `claude`, and an outbox row processed.

- [ ] **Step 4: Test concurrency (the "type, wait, retype" scenario)**

In rapid succession (within a second), send two messages from Telegram. Both should be acknowledged in order, with the second one resuming the same session as the first. The reply order in Telegram should match the input order.

Inspect:

```bash
sqlite3 ~/.config/agentio/daemon.db "SELECT * FROM chat_sessions;"
sqlite3 ~/.config/agentio/daemon.db "SELECT id, status, content FROM inbox WHERE service='telegram' ORDER BY received_at DESC LIMIT 5;"
sqlite3 ~/.config/agentio/daemon.db "SELECT id, status, content FROM outbox WHERE service='telegram' ORDER BY queued_at DESC LIMIT 5;"
```

Expected:
- One row per `chat_id` in `chat_sessions`, with `turn_count` ≥ 2.
- Both inbox messages are `done`.
- Two outbox messages exist, both `sent`.

- [ ] **Step 5: Disable bot, confirm passthrough still works**

```bash
bun run dev telegram profile bot disable --profile <test-profile>
bun run dev daemon restart
```

Send another message. Expected: it appears in `inbox pull` as `pending` but no reply is sent.

- [ ] **Step 6: Commit any incidental fixes**

If any issues surfaced during manual testing, write a regression test, fix, and commit. Otherwise, no commit needed.

---

## Task 14: Documentation update

**Files:**
- Modify: `CLAUDE.md` — document the bot feature.

- [ ] **Step 1: Add a "Claude Bot" section to `CLAUDE.md`**

Edit `CLAUDE.md`. Find the Telegram commands section (search for `### Telegram`). After the existing Telegram outbox commands, add a new subsection:

```markdown
### Telegram Bot Auto-Reply

When enabled on a profile, the daemon spawns `claude` for every inbound message and sends the response back via the outbox. Each Telegram chat gets its own persistent Claude session (via `--resume`); messages within a chat are processed serially while different chats run in parallel.

```bash
agentio telegram profile bot enable --profile <name> [--model sonnet|opus|haiku] [--permission-mode bypassPermissions|...]  [--system-prompt "..."]  [--cwd <dir>]
agentio telegram profile bot disable --profile <name>
agentio telegram profile bot show --profile <name>
```

Sessions are stored in the `chat_sessions` table of `~/.config/agentio/daemon.db`. Logs land in `~/.config/agentio/bot-runs/<service>/<profile>/<chat_id>/`. Read-only profiles cannot have the bot enabled.
```

Also add a one-line mention in the **Daemon Architecture** section near the existing scheduler description:

```markdown
- **Conversation bot**: When a profile has `bot.enabled`, inbound messages spawn `claude --resume <session-id>` per chat (serialized per chat, parallel across chats); replies route back through the outbox.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Telegram bot auto-reply feature"
```

---

## Self-Review Checklist (run before declaring done)

- [ ] **Spec coverage**
  - Generic primitive shared between schedule and inbound: ✔ Task 3 (`executeClaude`), Task 4 (schedule refactored to use it).
  - Per-conversation persistent session: ✔ Task 5 (`chat_sessions`), Task 10 (lookup + `--resume`).
  - Per-chat serialization, parallel across chats: ✔ Task 6 (queue), Task 11 (dispatch keyed by `service:profile:chatId`).
  - Reply routed via existing outbox: ✔ Task 10 (`insertOutbox`), Task 11 wires it.
  - Long replies split for Telegram 4096 limit: ✔ Task 7.
  - Read-only profiles cannot enable bot: ✔ Task 9.
  - CLI to enable/disable/show: ✔ Task 12.
  - Manual e2e: ✔ Task 13.

- [ ] **Type consistency**
  - `Spawner`, `Model`, `PermissionMode` consistent across `claude/runner.ts`, `schedule/runner.ts`, `conversation/runner.ts`: yes (all imported from `../../types/schedule` or `../claude/runner`).
  - `BotConfig` shape consistent between `types/bot.ts`, `types/config.ts` (via `ProfileEntry.bot`), `config-manager.ts`, and CLI: yes.
  - `service` field always typed as `ServiceName`: yes.

- [ ] **No placeholders**
  - Every step has full code or a concrete command. No "TBD", "implement later", or unfilled steps.
  - The one conditional ("if `markInboxDone` does not exist, add this") includes the actual code to add.
  - The integration-test fallback ("drop if cost is too high") includes a concrete decision rule.

- [ ] **Generic surface**
  - `runConversation` is service-agnostic: takes `service: ServiceName`. Works for `whatsapp` once the WhatsApp adapter starts emitting inbound messages too — no Telegram-specific code in the runner.
  - `BotConfig` lives on `ProfileEntry`, not on a Telegram-specific type — any service's profile can opt in.
  - Per-service character limits encapsulated in `limitFor()` (Task 10) — easy to add new services.

---

## Out of Scope (intentional v1 omissions)

- **Streaming partial replies** to Telegram (edit-as-you-go). v1 sends a single batched reply.
- **Mid-conversation cancellation.** If the user wants to cancel an in-flight Claude run, they currently can't — the queued message will run to completion.
- **Automatic `/compact`** on long sessions. The schedule runner doesn't auto-compact either; out of scope here.
- **Inbound media handling** (Claude doesn't see images/audio). Bot only fires when `message.content` is non-empty text.
- **Loop prevention beyond sender check.** If a profile sends a message that triggers another bot in the same channel, infinite loop is theoretically possible. Mitigation: configure each bot to ignore messages whose sender matches its own bot username — defer to a follow-up if it bites in practice.
