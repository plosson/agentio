import { listProfileRefs } from '../config/config-manager';
import { saveProfileForKey, validateProfileName, writeFailure } from '../config/profile-store';
import { findSessionPlugin, getPluginRegistry } from '../plugins/registry';
import {
  isLegacyServicePlugin,
  type Pairing,
  type PairingStatus,
  type Session,
  type SessionHost,
  type SessionPlugin,
  type SessionStatus,
} from '../plugins/types';
import { CliError } from '../utils/errors';
import { daemonLog } from './http';
import {
  createStore,
  deleteStore,
  discardStore,
  openProfileStore,
  renameStore,
  restoreStore,
  setAsideStore,
  storeSegment,
  StoreUnavailable,
  STORE_KEY_FIELD,
  type OpenStore,
  type PluginStore,
} from './plugin-store';

/**
 * The session supervisor. A plugin with `session` has one long-lived
 * connection per profile, which the daemon holds open while the vault is
 * unlocked: started on unlock, stopped on lock and shutdown, and reconciled
 * after every profile change the daemon makes.
 *
 * This is not the token keepalive (keepalive.ts), which refreshes on a timer,
 * nor the admin UI's browser sessions (session.ts). With no session plugin
 * registered, nothing here does anything.
 */

interface Entry {
  service: string;
  name: string;
  store: OpenStore | null;
  session: Session | null;
  /** Why there is no session, when there is none. */
  status: SessionStatus;
}

const entries = new Map<string, Entry>();
let active = false;

const refOf = (service: string, name: string) => `${service}/${name}`;


function sessionServices(): string[] {
  return getPluginRegistry().plugins.filter((p) => isLegacyServicePlugin(p) && p.session).map((p) => p.id);
}

// Starting, stopping and reconciling run one at a time, so a lock that lands
// mid-reconcile cannot leave a session running with nobody tracking it.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

export function sessionHost(service: string, name: string, store: PluginStore): SessionHost {
  return { store, log: (fields) => daemonLog('session', { service, profile: name, ...fields }) };
}

const reasonText = (err: unknown) => (err instanceof CliError ? err.code : err instanceof Error ? err.message : String(err));

async function startOne(plugin: SessionPlugin, service: string, name: string): Promise<void> {
  const entry: Entry = { service, name, store: null, session: null, status: { state: 'connecting' } };
  entries.set(refOf(service, name), entry);
  try {
    entry.store = await openProfileStore(service, name);
  } catch (err) {
    const needsPairing = err instanceof StoreUnavailable;
    entry.status = needsPairing
      ? { state: 'needs_pairing', detail: err.reason === 'missing' ? 'the store is missing' : 'the store does not match its key' }
      : { state: 'closed', detail: reasonText(err) };
    daemonLog('session', { service, profile: name, outcome: needsPairing ? 'needs_pairing' : 'failed', reason: needsPairing ? err.reason : reasonText(err) });
    return;
  }
  try {
    entry.session = await plugin.start(name, sessionHost(service, name, entry.store));
    daemonLog('session', { service, profile: name, outcome: 'started' });
  } catch (err) {
    entry.store.close();
    entry.store = null;
    entry.status = { state: 'closed', detail: reasonText(err) };
    daemonLog('session', { service, profile: name, outcome: 'failed', reason: reasonText(err) });
  }
}

async function stopOne(ref: string, options: { logout?: boolean } = {}): Promise<void> {
  const entry = entries.get(ref);
  if (!entry) return;
  entries.delete(ref);
  try {
    await entry.session?.stop(options);
  } catch (err) {
    daemonLog('session', { service: entry.service, profile: entry.name, outcome: 'stop_failed', reason: reasonText(err) });
  } finally {
    entry.store?.close();
  }
  if (entry.session) daemonLog('session', { service: entry.service, profile: entry.name, outcome: 'stopped', logout: options.logout || undefined });
}

/** Start what should run and stop what should not. Only runs while the vault is unlocked. */
async function reconcile(): Promise<void> {
  if (!active) return;
  const services = new Set(sessionServices());
  if (services.size === 0 && entries.size === 0) return;
  let wanted: Array<{ service: string; name: string }>;
  try {
    wanted = (await listProfileRefs()).filter((r) => services.has(r.service));
  } catch (err) {
    daemonLog('session', { outcome: 'reconcile_failed', reason: reasonText(err) });
    return;
  }
  const keep = new Set(wanted.map((r) => refOf(r.service, r.name)));
  for (const ref of [...entries.keys()]) if (!keep.has(ref)) await stopOne(ref);
  for (const { service, name } of wanted) {
    // A lock may have landed while an earlier profile was starting.
    if (!active) return;
    const ref = refOf(service, name);
    // A profile being paired again has a new, not yet recorded, store.
    if (!entries.has(ref) && !pairingInProgress(ref)) await startOne(findSessionPlugin(service)!, service, name);
  }
}

/** On unlock: start a session for every profile of every plugin with `session`. */
export function startSessions(): Promise<void> {
  active = true;
  // Outcomes of pairings from before the lock are nobody's to read any more.
  for (const [ref, entry] of pairings) if (entry.final) pairings.delete(ref);
  return serialized(reconcile);
}

/** On lock and shutdown: stop every session, each writing its state, and close every store. */
export function stopSessions(): Promise<void> {
  // Set at once, so a start queued behind this cannot run against a locked vault.
  active = false;
  // A pairing cannot be recorded in a locked vault; each ends, and is waited for, so its store is gone too.
  const ending = [...pairings.values()].filter((entry) => !entry.final);
  for (const entry of ending) void entry.pairing.cancel();
  const stopped = serialized(async () => {
    for (const ref of [...entries.keys()]) await stopOne(ref);
  });
  return stopped.then(() => Promise.all(ending.map((entry) => entry.finished))).then(() => {});
}

/** After a profile change the daemon made: start new profiles' sessions, stop removed ones'. */
export function reconcileSessions(): Promise<void> {
  return serialized(reconcile);
}

/** After a rename: the session stops, its store moves with the profile, and it starts again under the new name. */
export function sessionProfileRenamed(service: string, from: string, to: string): Promise<void> {
  if (!findSessionPlugin(service)) return Promise.resolve();
  return serialized(async () => {
    await stopOne(refOf(service, from));
    // A reconcile between the vault write and this call may have tried the new name before its store moved.
    await stopOne(refOf(service, to));
    await renameStore(service, from, to);
    await reconcile();
  });
}

/** After a removal: the account is logged out, best effort, and the store is deleted with the profile. */
export function sessionProfileRemoved(service: string, name: string): Promise<void> {
  if (!findSessionPlugin(service)) return Promise.resolve();
  const pairing = pairings.get(refOf(service, name));
  if (pairing && !pairing.final) {
    // Nothing to put back for a profile that is gone.
    pairing.dropAside = true;
    void pairing.pairing.cancel();
  }
  return serialized(async () => {
    await stopOne(refOf(service, name), { logout: true });
    await deleteStore(service, name);
  });
}

/** A profile's session state as the daemon sees it. */
export function sessionStatus(service: string, name: string): SessionStatus {
  const entry = entries.get(refOf(service, name));
  if (!entry) return { state: 'closed', detail: active ? 'no session for this profile' : 'the vault is locked' };
  return entry.session ? entry.session.status() : entry.status;
}

/** The running session for a profile, or a CliError saying why there is none. */
export function requireSession(service: string, name: string): Session {
  const entry = entries.get(refOf(service, name));
  if (entry?.session) return entry.session;
  const status = sessionStatus(service, name);
  if (status.state === 'needs_pairing') {
    throw new CliError('AUTH_EXPIRED', `The ${service} profile "${name}" needs pairing: ${status.detail}`,
      `Run: agentio ${service} profile add --profile ${name}`);
  }
  throw new CliError('API_ERROR', `No ${service} session is running for "${name}"${status.detail ? `: ${status.detail}` : ''}`,
    'Check the daemon log');
}

/** Whether the supervisor is running sessions, for tests and status. */
export function sessionsActive(): boolean {
  return active;
}

/**
 * Pairing. A pairing links a new account into a fresh store. An existing
 * profile's store is set aside first, with its session stopped, and comes back
 * if the pairing fails, so pairing again never loses a working account to a
 * QR code nobody scanned. Once paired, the profile and its store key are
 * written to the vault in one write, and the pairing's socket becomes the
 * profile's session.
 */

/** Long enough to scan a few rotating QR codes or type a pairing code; WhatsApp gives up sooner. */
export const PAIRING_TIMEOUT_MS = 3 * 60_000;
/** How long the outcome stays readable, so a client polling slowly still learns it. */
const PAIRING_KEPT_MS = 10 * 60_000;

interface PairingEntry {
  service: string;
  name: string;
  /** Only the key that started a pairing may read or cancel it: its QR code links an account. */
  keyId: string;
  readOnly?: boolean;
  pairing: Pairing;
  key: string;
  store: OpenStore;
  aside: string | null;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  dropAside: boolean;
  final: PairingStatus | null;
  endedAt: number;
  /** Settles once the outcome is recorded and everything the pairing left is cleaned up. */
  finished: Promise<void>;
}

const pairings = new Map<string, PairingEntry>();

function pairingInProgress(ref: string): boolean {
  const entry = pairings.get(ref);
  return !!entry && !entry.final;
}

export interface PairingRequest {
  keyId: string;
  phone?: string;
  readOnly?: boolean;
  timeoutMs?: number;
}

/** Start pairing a profile, new or existing. The caller has checked the key may manage it. */
export function startPairing(service: string, name: string, request: PairingRequest): Promise<void> {
  const plugin = findSessionPlugin(service);
  if (!plugin) throw new CliError('NOT_FOUND', `${service} has no session to pair`);
  validateProfileName(name);
  storeSegment(name);
  const ref = refOf(service, name);
  return serialized(async () => {
    if (!active) throw new CliError('VAULT_LOCKED', 'Vault is locked');
    if (pairingInProgress(ref)) {
      throw new CliError('INVALID_PARAMS', `A pairing is already in progress for ${ref}`, 'Finish it, or wait for it to expire');
    }
    await stopOne(ref);
    const aside = await setAsideStore(service, name);
    const { key, store } = await createStore(service, name);
    let pairing: Pairing;
    try {
      pairing = await plugin.pair(name, { phone: request.phone }, sessionHost(service, name, store));
    } catch (err) {
      store.close();
      await deleteStore(service, name);
      if (aside) await restoreStore(service, name, aside);
      await reconcile();
      throw err;
    }
    const entry: PairingEntry = {
      service, name, keyId: request.keyId, readOnly: request.readOnly, pairing, key, store, aside,
      timedOut: false, dropAside: false, final: null, endedAt: 0, finished: Promise.resolve(),
      timer: setTimeout(() => {
        entry.timedOut = true;
        void pairing.cancel();
      }, request.timeoutMs ?? PAIRING_TIMEOUT_MS),
    };
    entry.timer.unref?.();
    pairings.set(ref, entry);
    daemonLog('session', { service, profile: name, outcome: 'pairing', method: request.phone ? 'code' : 'qr' });
    entry.finished = pairing.done.then(
      (result) => serialized(() => finishPairing(entry, result)),
      (err) => serialized(() => finishPairing(entry, null, err)),
    ).catch((err) => {
      daemonLog('session', { service, profile: name, outcome: 'pairing_cleanup_failed', reason: reasonText(err) });
    });
  });
}

async function finishPairing(entry: PairingEntry, result: { session: Session; account?: string } | null, err?: unknown): Promise<void> {
  clearTimeout(entry.timer);
  const { service, name } = entry;
  const ref = refOf(service, name);
  let failure: string | null = null;

  if (result && active && !entry.dropAside) {
    try {
      const credentials = { [STORE_KEY_FIELD]: entry.key, ...(result.account ? { account: result.account } : {}) };
      const refused = writeFailure(await saveProfileForKey(entry.keyId, service, name, credentials, { readOnly: entry.readOnly }), service, name);
      if (refused) failure = refused.message;
    } catch (error) {
      failure = reasonText(error);
    }
    if (!failure) {
      await stopOne(ref);
      entries.set(ref, { service, name, store: entry.store, session: result.session, status: { state: 'open' } });
      if (entry.aside) await discardStore(entry.aside);
      entry.final = { state: 'paired', account: result.account };
      entry.endedAt = Date.now();
      daemonLog('session', { service, profile: name, outcome: 'paired' });
      return;
    }
  } else if (result) {
    failure = entry.dropAside ? 'the profile was removed' : 'the vault was locked';
  }

  // Not paired, or paired but not kept: nothing of the new link survives.
  if (result) {
    try {
      await result.session.stop({ logout: true });
    } catch {
      // Best effort: the store holding it is deleted next.
    }
  }
  entry.store.close();
  await deleteStore(service, name);
  if (entry.aside) {
    if (entry.dropAside) await discardStore(entry.aside);
    else await restoreStore(service, name, entry.aside);
  }
  const status = entry.pairing.status();
  entry.final = failure !== null ? { state: 'error', message: failure }
    : entry.timedOut ? { state: 'expired' }
    : err !== undefined ? { state: 'error', message: reasonText(err) }
    : status.state === 'expired' || status.state === 'error' ? status
    : { state: 'error', message: 'pairing was cancelled' };
  entry.endedAt = Date.now();
  daemonLog('session', { service, profile: name, outcome: `pairing_${entry.final.state}` });
  await reconcile();
}

/** The pairing this key started for a profile, or NOT_FOUND. */
function ownPairing(service: string, name: string, keyId: string): PairingEntry {
  const ref = refOf(service, name);
  const entry = pairings.get(ref);
  if (entry?.final && Date.now() - entry.endedAt > PAIRING_KEPT_MS) pairings.delete(ref);
  const kept = pairings.get(ref);
  if (!kept || kept.keyId !== keyId) throw new CliError('NOT_FOUND', `No pairing in progress for ${ref}`);
  return kept;
}

/** Where a pairing stands. Linked but not yet recorded still reads as waiting. */
export function pairingStatus(service: string, name: string, keyId: string): PairingStatus {
  const entry = ownPairing(service, name, keyId);
  if (entry.final) return entry.final;
  const status = entry.pairing.status();
  return status.state === 'waiting' ? status : { state: 'waiting' };
}

export async function cancelPairing(service: string, name: string, keyId: string): Promise<void> {
  const entry = ownPairing(service, name, keyId);
  if (!entry.final) await entry.pairing.cancel();
}
