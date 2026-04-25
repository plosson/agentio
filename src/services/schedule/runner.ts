import { spawn } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FrontmatterConfig } from '../../types/schedule';
import { shellEnv, locateClaude } from '../claude/claude-binary';
import { executeClaude, type Spawner } from '../claude/runner';
import { updateState } from './state';

export type { Spawner };

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
  /** injected for tests */
  now?: () => Date;
  /** injected for tests; defaults to process.stdout */
  stdout?: { write: (chunk: string | Buffer) => boolean };
  /** injected for tests; defaults to process.stderr */
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
