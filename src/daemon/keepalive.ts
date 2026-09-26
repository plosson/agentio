import { listProfileRefs } from '../config/config-manager';
import { getFreshCredentials, HUB_REFRESH_BUFFER_MS } from '../auth/refresh';
import { getAllCredentials, hasStored } from '../auth/token-store';
import { isVaultUnlocked } from '../vault/vault';
import { CliError } from '../utils/errors';
import { daemonLog } from './http';

/**
 * Keeping refresh tokens alive.
 *
 * A refresh token that nothing uses dies of disuse: Google drops one after six
 * months idle, Atlassian after about ninety days. The hub is the only process
 * that refreshes, so it is the only thing that can stop that happening.
 *
 * The pass does not force. `getFreshCredentials` renews a profile whose access
 * token is near expiry, which after a week is every OAuth profile and no
 * static one. Be clear about what that means: the cadence is set by the access
 * token's lifetime, an hour or so, not by the refresh token's idle window,
 * which is months, so a pass renews far more often than the risk strictly
 * needs. Doing better would mean storing a per-profile `lastRefreshedAt` and a
 * per-service idle horizon. It is the reason the default is weekly rather than
 * daily: Atlassian rotates its refresh token on every exchange, and each
 * rotation has a window where the new token has been issued but not yet
 * written to the vault.
 *
 * What this does not save: an absolute lifetime (Atlassian expires a refresh
 * token about a year after issue, however often it is used) and a revocation.
 * Both still need someone to reauthenticate on the hub host.
 */

/** Weekly: an order of magnitude inside the tightest provider window, without needless rotation. */
export const DEFAULT_INTERVAL_HOURS = 168;
/** An hour is the shortest useful gap, since access tokens live about that long. */
export const MIN_INTERVAL_HOURS = 1;
/** Two weeks. Also keeps the delay well inside setTimeout's 32-bit millisecond range. */
export const MAX_INTERVAL_HOURS = 336;

export interface PassResult {
  /** Profiles whose token was renewed. */
  refreshed: number;
  /** Profiles whose token was still good, or that have nothing to refresh. */
  fresh: number;
  /** Profiles with nothing stored yet: added but never authorised. */
  skipped: number;
  failed: number;
}

const empty = (): PassResult => ({ refreshed: 0, fresh: 0, skipped: 0, failed: 0 });

/**
 * Hours between passes, from `AGENTIO_KEEPALIVE_HOURS`. Zero turns the loop
 * off. Anything else is clamped into range, and anything unparseable falls
 * back to the default, always with a line saying so: a typo must not keep the
 * hub from serving credentials, and an out-of-range value must not silently
 * become something wildly different. Above the maximum an unclamped delay
 * would overflow setTimeout's 32-bit millisecond argument and fire at once,
 * over and over, which is the worst thing this module could possibly do.
 */
export function intervalHours(raw = process.env.AGENTIO_KEEPALIVE_HOURS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) {
    console.log(`Ignoring AGENTIO_KEEPALIVE_HOURS="${raw}": not a number of hours`);
    return DEFAULT_INTERVAL_HOURS;
  }
  if (hours === 0) return 0;
  const clamped = Math.min(Math.max(hours, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
  if (clamped !== hours) {
    console.log(`AGENTIO_KEEPALIVE_HOURS=${hours} is outside ${MIN_INTERVAL_HOURS}-${MAX_INTERVAL_HOURS}, using ${clamped}`);
  }
  return clamped;
}

let running = false;

/**
 * Refresh every profile that needs it, one at a time. Always resolves: the
 * only caller is a timer, so a rejection would surface as an unhandled one
 * rather than as a line an operator can grep.
 */
export async function runRefreshPass(): Promise<PassResult> {
  if (!isVaultUnlocked()) {
    daemonLog('keepalive', { outcome: 'skipped', reason: 'vault is locked' });
    return empty();
  }
  if (running) {
    daemonLog('keepalive', { outcome: 'skipped', reason: 'a pass is already running' });
    return empty();
  }
  running = true;
  try {
    return await walk();
  } catch (err) {
    // Locking the vault mid-pass, or a vault that moved, lands here rather than
    // in the per-profile catch, because the two listing reads happen first.
    const reason = err instanceof CliError ? err.code : err instanceof Error ? err.message : String(err);
    daemonLog('keepalive', { outcome: 'aborted', reason });
    return empty();
  } finally {
    running = false;
  }
}

/** The pass itself, once it is the only one running against an unlocked vault. */
async function walk(): Promise<PassResult> {
  const result = empty();
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
      const { refreshed } = await getFreshCredentials(ref.service, ref.name, { bufferMs: HUB_REFRESH_BUFFER_MS });
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

let timer: ReturnType<typeof setTimeout> | null = null;
let gapMs = 0;

/**
 * Start the loop, or say why it is off. Unlocking the vault is what starts it,
 * so the first pass happens when the tokens actually become reachable rather
 * than at a fixed point after boot, which a hub that starts locked would miss
 * entirely. Calling it again restarts cleanly.
 *
 * Each pass schedules the next from its own completion, so the knob means the
 * gap between passes and two can never overlap however slow a provider is. The
 * timer is unref'd so importing this module cannot hold a test runner open;
 * the daemon's own liveness comes from `Bun.serve`.
 */
export function startKeepalive(hours = intervalHours()): void {
  stopKeepalive();
  if (hours === 0) {
    console.log('Token keepalive is off (AGENTIO_KEEPALIVE_HOURS=0)');
    return;
  }
  gapMs = hours * 60 * 60 * 1000;
  console.log(`Token keepalive every ${hours}h`);
  schedule(0);
}

function schedule(delayMs: number): void {
  const handle = setTimeout(() => {
    void runRefreshPass().finally(() => {
      // Only carry on if nothing stopped or restarted the loop while the pass ran.
      if (timer === handle) schedule(gapMs);
    });
  }, delayMs);
  handle.unref?.();
  timer = handle;
}

export function stopKeepalive(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Whether the loop is on, so a caller can tell "off" from "between passes". */
export function keepaliveRunning(): boolean {
  return timer !== null;
}
