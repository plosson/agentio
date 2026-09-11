import { Command } from 'commander';
import { handleError } from '../utils/errors';
import { vaultExists } from '../vault/vault';
import { loadConfig } from '../config/config-manager';
import type { Config } from '../types/config';
import { readPointer } from '../vault/pointer';
import { isDaemonInstalled } from '../utils/daemon-ensure';
import { isDaemonAvailable } from '../daemon/client';
import { addExamples } from '../utils/command-tree';

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

async function checkDaemon(): Promise<Check> {
  const healthy = await isDaemonAvailable();
  if (healthy) return { name: 'Daemon', status: 'ok', detail: 'running' };

  if (isDaemonInstalled()) {
    return { name: 'Daemon', status: 'warn', detail: 'installed but not running', fix: 'agentio daemon start' };
  }
  return { name: 'Daemon', status: 'warn', detail: 'not installed', fix: 'agentio daemon install' };
}

function checkProfiles(cfg: Config | null): Check {
  if (!cfg) return { name: 'Profiles', status: 'error', detail: 'cannot read config' };
  const total = Object.values(cfg.profiles).reduce((acc, arr) => acc + (arr ?? []).length, 0);
  if (total === 0) {
    return {
      name: 'Profiles',
      status: 'warn',
      detail: 'no services configured',
      fix: 'agentio <service> profile add (e.g. gmail, slack, telegram)',
    };
  }
  return { name: 'Profiles', status: 'ok', detail: `${total} configured` };
}

export function registerDoctorCommand(program: Command): void {
  const doctorCmd = program
    .command('doctor')
    .description('Diagnose vault, daemon, and profiles')
    .action(async () => {
      try {
        const cfg = await loadConfig().catch(() => null);

        const checks: Check[] = [];
        checks.push(await checkVault());
        checks.push(await checkDaemon());
        checks.push(checkProfiles(cfg));

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
