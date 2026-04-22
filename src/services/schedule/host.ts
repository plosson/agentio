import { hostname } from 'os';
import type { FrontmatterConfig } from '../../types/schedule';

/** Return the current machine's hostname, as reported by `os.hostname()`. */
export function getCurrentHost(): string {
  return hostname();
}

/**
 * A schedule is "intended for this host" when:
 *  - no `host` field is set (default: all machines), or
 *  - `host` matches the current hostname exactly
 */
export function hostMatches(config: { host?: string }, current: string = getCurrentHost()): boolean {
  if (!config.host) return true;
  return config.host === current;
}

export type { FrontmatterConfig };
