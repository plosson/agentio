import { listProfileRefs } from '../config/config-manager';
import { getPluginRegistry } from '../plugins/registry';
import { isLegacyServicePlugin, type Session, type SessionHost, type SessionPlugin, type SessionStatus } from '../plugins/types';
import { CliError } from '../utils/errors';
import { daemonLog } from './http';
import { deleteStore, openProfileStore, renameStore, StoreUnavailable, type OpenStore, type PluginStore } from './plugin-store';

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

/** The session capability of a registered plugin, if it has one. */
export function sessionPluginFor(service: string): SessionPlugin | undefined {
  const plugin = getPluginRegistry().find(service);
  return plugin && isLegacyServicePlugin(plugin) ? plugin.session : undefined;
}

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
    if (!entries.has(refOf(service, name))) await startOne(sessionPluginFor(service)!, service, name);
  }
}

/** On unlock: start a session for every profile of every plugin with `session`. */
export function startSessions(): Promise<void> {
  active = true;
  return serialized(reconcile);
}

/** On lock and shutdown: stop every session, each writing its state, and close every store. */
export function stopSessions(): Promise<void> {
  // Set at once, so a start queued behind this cannot run against a locked vault.
  active = false;
  return serialized(async () => {
    for (const ref of [...entries.keys()]) await stopOne(ref);
  });
}

/** After a profile change the daemon made: start new profiles' sessions, stop removed ones'. */
export function reconcileSessions(): Promise<void> {
  return serialized(reconcile);
}

/** After a rename: the session stops, its store moves with the profile, and it starts again under the new name. */
export function sessionProfileRenamed(service: string, from: string, to: string): Promise<void> {
  if (!sessionPluginFor(service)) return Promise.resolve();
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
  if (!sessionPluginFor(service)) return Promise.resolve();
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
