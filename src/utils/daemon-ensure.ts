import { confirm } from '@inquirer/prompts';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'bun';
import { isInteractive } from './interactive';
import { loadConfig } from '../config/config-manager';

export type DaemonAction = 'running' | 'start' | 'install';

/** Pure decision: given probe results, what should we do? */
export function decideDaemonAction(input: {
  healthOk: boolean;
  installed: boolean;
}): DaemonAction {
  if (input.healthOk) return 'running';
  if (input.installed) return 'start';
  return 'install';
}

function isDaemonInstalled(): boolean {
  if (process.platform === 'darwin') {
    return existsSync(join(homedir(), 'Library', 'LaunchAgents', 'me.agentio.daemon.plist'));
  }
  if (process.platform === 'linux') {
    return existsSync('/etc/systemd/system/agentio-daemon.service');
  }
  return false;
}

async function isDaemonHealthy(): Promise<boolean> {
  let cfg;
  try {
    cfg = await loadConfig();
  } catch {
    return false;
  }
  const port = cfg.daemon?.server?.port ?? 7890;
  const apiKey = cfg.daemon?.apiKey;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the daemon is running. If not, prompt the user (in interactive mode)
 * to start (and possibly install) it. Returns true iff the daemon is now reachable.
 */
export async function ensureDaemonRunning(opts: { autoYes?: boolean } = {}): Promise<boolean> {
  const healthOk = await isDaemonHealthy();
  if (healthOk) return true;
  const installed = isDaemonInstalled();
  const action = decideDaemonAction({ healthOk, installed });

  const askYes = async (msg: string): Promise<boolean> => {
    if (opts.autoYes) return true;
    if (!isInteractive()) return false;
    return confirm({ message: msg, default: true });
  };

  if (action === 'install') {
    const ok = await askYes('The agentio daemon is not installed. Install and start it now?');
    if (!ok) return false;
    spawnSync({
      cmd: [process.execPath, ...process.argv.slice(1, 2), 'daemon', 'install'],
      stdout: 'inherit', stderr: 'inherit',
    });
    return await isDaemonHealthy();
  }
  if (action === 'start') {
    const ok = await askYes('The agentio daemon is installed but not running. Start it now?');
    if (!ok) return false;
    spawnSync({
      cmd: [process.execPath, ...process.argv.slice(1, 2), 'daemon', 'start'],
      stdout: 'inherit', stderr: 'inherit',
    });
    // Give the daemon a moment to come up.
    await new Promise((r) => setTimeout(r, 1500));
    return await isDaemonHealthy();
  }
  return false;
}
