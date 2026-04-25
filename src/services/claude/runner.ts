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
  env: NodeJS.ProcessEnv;
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
