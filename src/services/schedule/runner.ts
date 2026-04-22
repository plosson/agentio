import { spawn, type ChildProcess } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FrontmatterConfig } from '../../types/schedule';
import { shellEnv, locateClaude } from './claude-binary';
import { updateState } from './state';

export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcess;

export interface RunScheduleOpts {
  folder: string;
  id: string;
  promptBody: string;
  config: FrontmatterConfig;
  /** When false, tee child stdout/stderr to process.stdout/stderr. Defaults to true. */
  quiet?: boolean;
  /** injected for tests; defaults to child_process.spawn */
  spawner?: Spawner;
  /** injected for tests; defaults to locateClaude() */
  claudePath?: string | null;
  now?: () => Date;
  /** injected for tests; defaults to process.stdout/process.stderr */
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

  let cmd: string;
  let args: string[];
  if (opts.config.command) {
    cmd = '/bin/zsh';
    args = ['-lic', opts.config.command];
  } else {
    const claude = opts.claudePath ?? locateClaude();
    if (!claude) {
      await appendFile(logPath,
        'ERROR: claude CLI not found. Tried PATH + ~/.claude/local/bin, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.\n');
      await writeSummary(logPath, { status: 'failed', exitCode: 127, startedAt: now, endedAt: new Date() });
      return { exitCode: 127, logPath };
    }
    cmd = claude;
    args = buildClaudeArgs(opts.config, opts.promptBody);
  }

  const spawnLine = `[${now.toISOString()}] spawn: ${cmd} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
  await appendFile(logPath, spawnLine);
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const tee = opts.quiet === false;
  if (tee) stderr.write(spawnLine);

  const child = spawner(cmd, args, { cwd: opts.folder, env });
  const startedAt = now;
  let sessionId: string | undefined;
  let buffer = '';
  const pending: Promise<void>[] = [];

  child.stdout?.on('data', (chunk: Buffer) => {
    if (tee) stdout.write(chunk);
    const p = (async () => {
      const text = chunk.toString('utf-8');
      await appendFile(logPath, text);
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
            sessionId = obj.session_id;
            await updateState(opts.folder, opts.id, { sessionId });
          }
        } catch { /* not JSON */ }
      }
    })();
    pending.push(p);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (tee) stderr.write(chunk);
    pending.push(appendFile(logPath, chunk.toString('utf-8')));
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });
  await Promise.all(pending);

  const endedAt = new Date();
  const status = exitCode === 0 ? 'succeeded' : 'failed';
  await writeSummary(logPath, { status, exitCode, sessionId, startedAt, endedAt });
  await updateState(opts.folder, opts.id, {
    lastRunAt: endedAt.toISOString(),
    lastExitCode: exitCode,
    ...(sessionId ? { sessionId } : {}),
  });

  return { exitCode, logPath, sessionId };
}

function buildClaudeArgs(config: FrontmatterConfig, prompt: string): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', config.model];
  switch (config.permissionMode) {
    case 'bypassPermissions': args.push('--dangerously-skip-permissions'); break;
    case 'plan':               args.push('--permission-mode', 'plan'); break;
    case 'acceptEdits':        args.push('--permission-mode', 'acceptEdits'); break;
    case 'default':            break;
  }
  args.push(prompt);
  return args;
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
