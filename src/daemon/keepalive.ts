import { listProfileRefs } from '../config/config-manager';
import { getFreshCredentials } from '../auth/refresh';
import { getAllCredentials, hasStored } from '../auth/token-store';
import { daemonLog } from './http';
import { isVaultUnlocked } from '../vault/vault';
import { CliError } from '../utils/errors';

/**
 * Keeping refresh tokens alive.
 *
 * A refresh token that nothing uses dies of disuse: Google drops one after six
 * months idle, Atlassian after about ninety days. The hub is the only process
 * that knows when a profile was last refreshed, because it is the only one
 * that refreshes, so it is the only thing that can stop that happening.
 *
 * The pass deliberately does not force. `getFreshCredentials` refreshes a
 * profile only when its access token is near expiry, which after a day is
 * every OAuth profile and no static one, so the ordinary path already selects
 * exactly the right set. Forcing would burn an Atlassian rotation for nothing.
 *
 * What this does not save: an absolute lifetime (Atlassian expires a refresh
 * token about a year after it was first issued, however often it is used) and
 * a revocation. Both still need someone to reauthenticate on the hub host.
 */

export const DEFAULT_INTERVAL_HOURS = 24;

/** A first pass runs this long after boot, once the server is answering. */
const SETTLE_MS = 60_000;

export interface PassResult {
  /** Profiles whose token was renewed. */
  refreshed: number;
  /** Profiles whose token was still good, or that have nothing to refresh. */
  fresh: number;
  /** Profiles with nothing stored yet: added but never authorised. */
  skipped: number;
  failed: number;
}

/**
 * Hours between passes, from `AGENTIO_REFRESH_HOURS`. Zero turns the loop off.
 * Anything unparseable falls back to the default rather than failing the boot:
 * a typo here must not keep the hub from serving credentials.
 */
export function intervalHours(raw = process.env.AGENTIO_REFRESH_HOURS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    console.log(`Ignoring AGENTIO_REFRESH_HOURS="${raw}": not a number of hours`);
    return DEFAULT_INTERVAL_HOURS;
  }
  return hours;
}

/**
 * Refresh every profile that needs it, one at a time. One slow or broken
 * profile must not hold up or abandon the rest, so each is awaited separately
 * and a failure is logged and counted. Serialisation per profile is already
 * `getFreshCredentials`'s job, which is what keeps a pass from racing an agent
 * request over Atlassian's rotating token.
 */
export async function runRefreshPass(): Promise<PassResult> {
  const result: PassResult = { refreshed: 0, fresh: 0, skipped: 0, failed: 0 };
  if (!isVaultUnlocked()) {
    daemonLog('keepalive', { outcome: 'skipped', reason: 'vault is locked' });
    return result;
  }

  // A profile with nothing stored is one the owner added but never authorised.
  // Asking to refresh it raises AUTH_FAILED, which would log an error on every
  // pass for as long as it exists, so it is passed over instead.
  const stored = await getAllCredentials();
  for (const ref of await listProfileRefs()) {
    if (!hasStored(stored, ref.service, ref.name)) {
      result.skipped++;
      continue;
    }
    try {
      const { refreshed } = await getFreshCredentials(ref.service, ref.name);
      if (refreshed) result.refreshed++;
      else result.fresh++;
    } catch (err) {
      result.failed++;
      const reason = err instanceof CliError ? err.code : err instanceof Error ? err.message : String(err);
      daemonLog('keepalive', { profile: `${ref.service}/${ref.name}`, outcome: 'failed', reason });
    }
  }

  daemonLog('keepalive', { outcome: 'pass', ...result });
  return result;
}

let first: ReturnType<typeof setTimeout> | null = null;
let repeat: ReturnType<typeof setInterval> | null = null;

/**
 * Start the loop, or say why it is off. Both timers are unref'd: the server
 * handle is what keeps the daemon alive, and a pending pass must never be the
 * reason the process lingers on shutdown.
 */
export function startKeepalive(hours = intervalHours()): void {
  if (hours === 0) {
    console.log('Token keepalive is off (AGENTIO_REFRESH_HOURS=0)');
    return;
  }
  const pass = () => { void runRefreshPass(); };
  first = setTimeout(pass, SETTLE_MS);
  repeat = setInterval(pass, hours * 60 * 60 * 1000);
  first.unref?.();
  repeat.unref?.();
  console.log(`Token keepalive every ${hours}h, first pass in ${SETTLE_MS / 1000}s`);
}

export function stopKeepalive(): void {
  if (first) clearTimeout(first);
  if (repeat) clearInterval(repeat);
  first = repeat = null;
}
