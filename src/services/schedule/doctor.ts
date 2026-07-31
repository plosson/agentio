import { spawn } from 'child_process';
import { shellEnv, locateClaude } from './claude-binary';
import type { Model } from '../../types/schedule';

/** Search paths reported when the claude CLI cannot be located. */
export const CLAUDE_SEARCH_PATHS = [
  'PATH (login shell)',
  '~/.claude/local/bin',
  '~/.local/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

export interface DoctorResult {
  /** Absolute path to the located claude binary, or null when not found. */
  claudePath: string | null;
  model: Model;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  /** True when claude was found and the smoke prompt exited 0. */
  ok: boolean;
}

export interface CheckClaudeOpts {
  model: Model;
  /** How long to wait for the smoke prompt before killing it. Default 60s. */
  timeoutMs?: number;
  prompt?: string;
  /** injected for tests; defaults to child_process.spawn */
  spawner?: typeof spawn;
  now?: () => number;
}

/**
 * Verify the scheduling prerequisite: the claude CLI is installed AND logged in.
 * Runs a trivial `--print` prompt through the same login-shell env the daemon
 * uses (CLAUDECODE stripped), so a green result means real scheduled runs can
 * spawn claude successfully. A not-logged-in CLI surfaces as a non-zero exit.
 */
export async function checkClaude(opts: CheckClaudeOpts): Promise<DoctorResult> {
  const claude = locateClaude();
  if (!claude) return { claudePath: null, model: opts.model, ok: false };

  const env = { ...shellEnv() } as Record<string, string>;
  delete env.CLAUDECODE;

  const prompt = opts.prompt ?? 'Reply with exactly: OK';
  const args = ['--print', '--model', opts.model, prompt];
  const spawner = opts.spawner ?? spawn;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const start = now();
  const child = spawner(claude, args, { cwd: process.cwd(), env });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
  child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

  const exitCode: number = await new Promise((res) => {
    child.on('close', (code) => res(code ?? 1));
    child.on('error', () => res(127));
  });
  clearTimeout(timer);

  const durationMs = now() - start;
  return {
    claudePath: claude,
    model: opts.model,
    exitCode,
    durationMs,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    timedOut,
    ok: !timedOut && exitCode === 0,
  };
}
