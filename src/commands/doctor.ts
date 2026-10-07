import { Command } from 'commander';
import { CliError, handleError } from '../utils/errors';
import { vaultExists } from '../vault/vault';
import { loadConfig } from '../config/config-manager';
import type { Config } from '../types/config';
import { readPointer } from '../vault/pointer';
import { getDaemonHealth } from '../daemon/client';
import { addExamples } from '../utils/command-tree';
import { hub, isRemoteMode, remoteCanManageProfiles, remoteProfiles } from '../auth/remote';
import { getCredentials } from '../auth/token-store';
import { listProfileRefs } from '../config/config-manager';
import { CLAUDE_CLI, CODEX_CLI, type CliTool } from '../utils/external-cli';
import { authExpiryStatus, authExpiresAt, type SpotifyCredentials } from '../plugins/spotify/types';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail?: string;
  items?: string[];
  fix?: string;
}

const SYMBOL: Record<Check['status'], string> = {
  ok: '✓',
  warn: '!',
  error: '✗',
};

export function renderChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    const symbol = SYMBOL[c.status];
    const head = `${symbol} ${c.name}`.padEnd(20);
    const detail = c.detail ? `— ${c.detail}` : '';
    lines.push(`${head} ${detail}`.trimEnd());
    if (c.items) for (const it of c.items) lines.push(`    ${it}`);
    if (c.fix) lines.push(`    fix: ${c.fix}`);
  }
  return lines.join('\n');
}

async function checkVault(): Promise<Check> {
  if (!(await vaultExists())) {
    return {
      name: 'Vault',
      status: 'error',
      detail: 'not configured',
      fix: 'agentio vault init',
    };
  }
  const path = await readPointer();
  return { name: 'Vault', status: 'ok', detail: `at ${path}` };
}

/** Remote mode: the hub is the vault. One call proves reachability, token, and lock state. */
async function checkHub(): Promise<Check> {
  const url = hub().url;
  try {
    const [profiles, canManageProfiles] = await Promise.all([remoteProfiles(), remoteCanManageProfiles()]);
    const may = canManageProfiles ? ', can manage profiles' : '';
    return { name: 'Hub', status: 'ok', detail: `${url}, ${profiles.length} profile(s) allowed for this token${may}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { name: 'Hub', status: 'error', detail, fix: err instanceof CliError ? err.suggestion : undefined };
  }
}

export async function checkDaemon(): Promise<Check> {
  const health = await getDaemonHealth();
  if (!health) return { name: 'Daemon', status: 'warn', detail: 'not running', fix: 'agentio daemon start' };
  if (health.locked) return { name: 'Daemon', status: 'warn', detail: 'running, vault locked' };
  return { name: 'Daemon', status: 'ok', detail: 'running' };
}

async function checkProfiles(): Promise<Check> {
  const cfg = await loadConfig().catch(() => null);
  if (!cfg) return { name: 'Profiles', status: 'error', detail: 'cannot read config' };
  const total = Object.values(cfg.profiles).reduce((acc, arr) => acc + (arr ?? []).length, 0);
  if (total === 0) {
    return {
      name: 'Profiles',
      status: 'warn',
      detail: 'no services configured',
      fix: 'agentio <service> profile add (e.g. gmail, slack, jira)',
    };
  }
  return { name: 'Profiles', status: 'ok', detail: `${total} configured` };
}


async function checkSpotifyAuth(): Promise<Check | null> {
  if (isRemoteMode()) return null;
  const refs = (await listProfileRefs()).filter((r) => r.service === 'spotify');
  if (refs.length === 0) return null;

  const items: string[] = [];
  let worst: Check['status'] = 'ok';
  for (const ref of refs) {
    const creds = await getCredentials<SpotifyCredentials>('spotify', ref.name);
    if (!creds?.authorizedAt) {
      items.push(`${ref.name}: missing authorizedAt`);
      worst = 'warn';
      continue;
    }
    const status = authExpiryStatus(creds.authorizedAt);
    const expires = authExpiresAt(creds.authorizedAt).toISOString();
    if (status === 'expired') {
      items.push(`${ref.name}: expired ${expires}`);
      worst = 'error';
    } else if (status === 'warn') {
      items.push(`${ref.name}: expires ${expires}`);
      if (worst === 'ok') worst = 'warn';
    }
  }

  if (items.length === 0) {
    return { name: 'Spotify auth', status: 'ok', detail: `${refs.length} profile(s), sign-in fresh` };
  }
  return {
    name: 'Spotify auth',
    status: worst,
    detail: worst === 'error' ? 'sign-in expired' : 'sign-in expiring soon',
    items,
    fix: 'agentio profile reauth spotify',
  };
}

/** Whether `tool` is installed, shown only where a profile of `service` can be used. Never runs a prompt. */
export async function checkCli(tool: CliTool, service: string, services: Set<string>): Promise<Check | null> {
  if (!services.has(service)) return null;
  const name = `${tool.command} CLI`;
  // Bun.which otherwise searches the PATH the process started with, not the current one.
  const path = Bun.which(tool.command, { PATH: process.env.PATH ?? '' });
  if (!path) return { name, status: 'warn', detail: 'not installed', fix: tool.install };
  const proc = Bun.spawn([path, '--version'], { env: process.env, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  const version = (await new Response(proc.stdout).text()).trim().split('\n')[0];
  await proc.exited;
  return { name, status: 'ok', detail: version ? `found, ${version}` : 'found' };
}

/** The CLI checks; none when profiles cannot be listed (hub down, token expired, vault locked), so the report still prints. */
export async function cliChecks(): Promise<Check[]> {
  const services = new Set((await listProfileRefs().catch(() => [])).map((r) => r.service));
  const found = await Promise.all([checkCli(CLAUDE_CLI, 'claude', services), checkCli(CODEX_CLI, 'chatgpt', services)]);
  return found.filter((c): c is Check => c !== null);
}

export function registerDoctorCommand(program: Command): void {
  const doctorCmd = program
    .command('doctor')
    .description('Diagnose vault, daemon, and profiles')
    .action(async () => {
      try {
        const checks: Check[] = isRemoteMode()
          ? [await checkHub()]
          : await Promise.all([checkVault(), checkDaemon(), checkProfiles()]);
        const spotifyAuth = await checkSpotifyAuth();
        if (spotifyAuth) checks.push(spotifyAuth);
        checks.push(...(await cliChecks()));

        console.log(renderChecks(checks));

        const errors = checks.filter((c) => c.status === 'error');
        if (errors.length > 0) process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });

  addExamples(
    doctorCmd,
    `Examples:

  # run all health checks (vault, daemon, profiles)
  agentio doctor`,
  );
}
