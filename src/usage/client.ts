import { hostname } from 'os';
import { agentioVersion } from '../utils/version';
import { COMMAND, HOST, LOCAL_KEY, USAGE_HEADERS } from './event';
import { firstUse, usageCommand } from './context';
import { recordUsage, warnOnce } from './store';

/** A local CLI read its own vault for a profile: record it once per run, inside a command only. */
export async function recordLocalUse(service: string, profile: string, found: boolean): Promise<void> {
  try {
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
  } catch (err) {
    // Best effort: building the event must never fail the credential read.
    warnOnce(err);
  }
}

/**
 * What a remote CLI tells the hub about itself with a credential request. The hub validates all of it.
 * Best effort: on failure it sends nothing, which the hub records as unknown, and never fails the request.
 */
export function usageHeaders(): Record<string, string> {
  try {
    const command = usageCommand();
    const host = hostname();
    // A value fetch refuses (a newline, a non-Latin-1 character) would fail the whole request:
    // send only what the hub would accept, and the hub records the rest as unknown.
    return {
      ...(command !== null && COMMAND.test(command) ? { [USAGE_HEADERS.command]: command } : {}),
      ...(HOST.test(host) ? { [USAGE_HEADERS.host]: host } : {}),
      [USAGE_HEADERS.version]: agentioVersion(),
    };
  } catch (err) {
    warnOnce(err);
    return {};
  }
}
