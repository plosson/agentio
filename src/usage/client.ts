import { hostname } from 'os';
import { agentioVersion } from '../utils/version';
import { LOCAL_KEY, USAGE_HEADERS } from './event';
import { firstUse, usageCommand } from './context';
import { recordUsage } from './store';

/** A local CLI read its own vault for a profile: record it once per run, inside a command only. */
export async function recordLocalUse(service: string, profile: string, found: boolean): Promise<void> {
  const command = usageCommand();
  if (command === null || !firstUse(service, profile)) return;
  await recordUsage({
    service,
    profile,
    command,
    host: hostname(),
    keyId: LOCAL_KEY,
    keyName: LOCAL_KEY,
    outcome: found ? 'ok' : 'not_found',
    refreshed: null,
    version: agentioVersion(),
  });
}

/** What a remote CLI tells the hub about itself with a credential request. The hub validates all of it. */
export function usageHeaders(): Record<string, string> {
  const command = usageCommand();
  return {
    ...(command !== null ? { [USAGE_HEADERS.command]: command } : {}),
    [USAGE_HEADERS.host]: hostname(),
    [USAGE_HEADERS.version]: agentioVersion(),
  };
}
