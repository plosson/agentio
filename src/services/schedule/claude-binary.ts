import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';

let cachedShellEnv: Record<string, string> | null = null;

/** Cached login-shell env (PATH etc.), mimicking claude-cron. */
export function shellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv;
  try {
    const out = execFileSync('/bin/zsh', ['-lic', 'env'], { encoding: 'utf-8' });
    const env: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!env.PATH) Object.assign(env, process.env);
    cachedShellEnv = env;
  } catch {
    cachedShellEnv = { ...process.env } as Record<string, string>;
  }
  return cachedShellEnv;
}

/** Locate the `claude` CLI binary, returning an absolute path or null. */
export function locateClaude(): string | null {
  const env = shellEnv();
  const paths = (env.PATH ?? '').split(':');
  for (const dir of paths) {
    if (!dir) continue;
    const candidate = `${dir}/claude`;
    if (existsSync(candidate)) return candidate;
  }
  const fallbacks = [
    `${homedir()}/.claude/local/bin/claude`,
    `${homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return null;
}
