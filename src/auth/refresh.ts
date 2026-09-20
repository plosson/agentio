import { CliError, noCredentialsError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import { findCredentialLifecycle } from '../plugins/credential-lifecycles';
import type { RegisteredCredentialLifecycle } from '../plugins/types';
import { getCredentials, setCredentials } from './token-store';

/** Refresh when the access token has less than this left. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** The hub refreshes earlier than a CLI would, so a token it hands out is never one the client wants to refresh itself. */
export const HUB_REFRESH_BUFFER_MS = 10 * 60 * 1000;

export interface FreshCredentials<T = Record<string, unknown>> {
  credentials: T;
  /** True when this call performed a refresh and wrote the vault. */
  refreshed: boolean;
}

export interface RefreshOptions {
  /** Override the expiry buffer; a long-lived hub uses a wider one than a CLI. */
  bufferMs?: number;
  /** Refresh even if the token looks fresh, e.g. after a validation failure. */
  force?: boolean;
}

interface Refresher<T> {
  /** Fields a remote agent must never receive: what would let it refresh on its own. */
  secretFields: readonly string[];
  /** Whether these particular credentials can be refreshed at all. */
  applies(creds: T): boolean;
  /** Whether the stored credentials are within `bufferMs` of expiring. */
  isStale(creds: T, now: number, bufferMs: number): boolean;
  /** Obtain new credentials; must not persist them. */
  refresh(creds: T): Promise<T>;
}

function refresherFor(service: ServiceName): RegisteredCredentialLifecycle | undefined {
  return findCredentialLifecycle(service);
}

/**
 * The credentials as a remote agent may see them: the refresh material stays on
 * the hub. Services without a refresher hold static secrets, which the hub
 * hands over whole; it is a transparent vault for those.
 */
export function redactForRemote(service: ServiceName, credentials: Record<string, unknown>): Record<string, unknown> {
  const refresher = refresherFor(service);
  if (!refresher) return credentials;
  const out = { ...credentials };
  for (const field of refresher.secretFields) delete out[field];
  return out;
}

// One chain per profile: concurrent callers for the same profile wait for the
// refresh in flight instead of each refreshing and clobbering the vault.
// Atlassian's rotating refresh tokens make the double refresh fatal, not just
// wasteful. This serialises within one process only; concurrent CLI
// invocations on the same vault are unchanged and unsupported (see
// docs/design/remote-vault.md). Entries are dropped once idle so the map
// holds neither results nor secrets between calls.
const chains = new Map<string, Promise<void>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/**
 * The credentials the local code path expects for `service/profile`, refreshed
 * and written back first when they are stale (or `force` is set). Static
 * services and profiles with nothing to refresh come back as stored. Throws
 * AUTH_FAILED when the profile has no credentials and TOKEN_EXPIRED when a
 * refresh is needed but fails; both mean re-authenticate.
 */
export function getFreshCredentials<T = Record<string, unknown>>(
  service: ServiceName,
  profile: string,
  options: RefreshOptions = {},
): Promise<FreshCredentials<T>> {
  return serialized(`${service}/${profile}`, async () => {
    const stored = await getCredentials<T>(service, profile);
    if (!stored) throw noCredentialsError(service, profile);

    const refresher = refresherFor(service) as Refresher<T> | undefined;
    const bufferMs = options.bufferMs ?? REFRESH_BUFFER_MS;
    const wanted = !!refresher && refresher.applies(stored)
      && (options.force || refresher.isStale(stored, Date.now(), bufferMs));
    if (!wanted) return { credentials: stored, refreshed: false };

    let fresh: T;
    try {
      fresh = await refresher!.refresh(stored);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliError(
        'TOKEN_EXPIRED',
        `Token refresh failed for ${service} profile "${profile}": ${reason}`,
        `Re-authenticate with: agentio ${service} profile add --profile ${profile}`,
      );
    }
    await setCredentials(service, profile, fresh as object);
    return { credentials: fresh, refreshed: true };
  });
}
