import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliError } from './errors';

/** A vendor CLI agentio runs prompts through; never installed by agentio. */
export interface CliTool {
  command: string;
  displayName: string;
  install: string;
}

export const CLAUDE_CLI: CliTool = { command: 'claude', displayName: 'Claude Code', install: 'curl -fsSL https://claude.ai/install.sh | bash' };
export const CODEX_CLI: CliTool = { command: 'codex', displayName: 'Codex', install: 'npm i -g @openai/codex' };

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Written for the model that reads it: what to run, how to check, and to retry. */
export function missingCliError(tool: CliTool): CliError {
  return new CliError(
    'CONFIG_ERROR',
    `The ${tool.command} CLI (${tool.displayName}) is not installed on this machine; agentio runs prompts through it`,
    `Install it with \`${tool.install}\`, check with \`${tool.command} --version\`, then run the same agentio command again`,
  );
}

/** Where `command` is on the current PATH, or null. Bun.which otherwise searches the PATH the process started with. */
export function whichOnPath(command: string): string | null {
  return Bun.which(command, { PATH: process.env.PATH ?? '' });
}

export function findCli(tool: CliTool): string {
  const path = whichOnPath(tool.command);
  if (!path) throw missingCliError(tool);
  return path;
}

/** A fresh directory for `fn`, removed afterwards whatever happens. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunExternalCliOptions {
  args: string[];
  /** Written to stdin, so its length is never limited by the command line. */
  input: string;
  cwd: string;
  /** Inherited variables removed first, so a stray key in the caller's shell cannot win. */
  unset: readonly string[];
  /** Then added. */
  env: Record<string, string>;
  timeoutMs?: number;
}

export async function runExternalCli(tool: CliTool, options: RunExternalCliOptions): Promise<CliRun> {
  const binary = findCli(tool);
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of options.unset) delete env[name];
  Object.assign(env, options.env);

  const proc = Bun.spawn([binary, ...options.args], {
    cwd: options.cwd,
    env,
    stdin: new Blob([options.input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // On a timeout the kill may leave a grandchild holding the pipes, so stop waiting for them.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new CliError('API_ERROR', `${tool.command} did not answer within ${Math.round(timeoutMs / 1000)} seconds`, 'Try a shorter prompt, or retry'));
    }, timeoutMs);
  });
  const finished = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
    ([exitCode, stdout, stderr]): CliRun => ({ exitCode, stdout, stderr }),
  );
  finished.catch(() => {});
  try {
    return await Promise.race([finished, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
