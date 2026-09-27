import { readFileSync, unlinkSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { assertTestWritable, configDir } from '../vault/pointer';
import { absentAsOutcome, hub, hubCall, isRemoteMode, remoteToken, type HubCallOptions } from '../auth/remote';
import { CliError } from '../utils/errors';
import type { WriteOutcome } from '../config/profile-store';
import { DAEMON_PORT, type HealthResponse } from './types';

const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/** Where a running daemon was reached, as it recorded it on start. */
export interface DaemonRecord {
  url: string;
  pid: number;
  /** This run's local token: the owner's credential for a CLI on this machine. */
  token?: string;
}

/**
 * The daemon records its address here, so the CLI finds a daemon started on
 * another host or port (or on `--port 0`). Per HOME, like the vault pointer.
 * The file is 0600 because it carries the local token: whoever can read the
 * config directory is trusted, as for the vault pointer.
 */
export function daemonRecordPath(): string {
  return join(configDir(), 'daemon.json');
}

export async function recordDaemon(record: DaemonRecord): Promise<void> {
  const path = daemonRecordPath();
  assertTestWritable(path, 'daemon record');
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(record) + '\n', { mode: 0o600 });
}

/** Remove the record, but only when it is this daemon's: a later one may have replaced it. */
export function forgetDaemon(pid: number): void {
  if (readDaemonRecord()?.pid !== pid) return;
  try {
    unlinkSync(daemonRecordPath());
  } catch {
    // Already gone.
  }
}

function readDaemonRecord(): DaemonRecord | null {
  try {
    const record = JSON.parse(readFileSync(daemonRecordPath(), 'utf8'));
    return typeof record?.url === 'string' && Number.isInteger(record?.pid) ? record : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The recorded daemon's URL while its process lives, else the default address. */
export function localDaemonUrl(): string {
  const record = readDaemonRecord();
  return record && isRunning(record.pid) ? record.url : DEFAULT_DAEMON_URL;
}

/** The running daemon and its local token, or null when none is running or it recorded no token. */
export function localDaemon(): { url: string; token: string } | null {
  const record = readDaemonRecord();
  if (!record || !isRunning(record.pid) || typeof record.token !== 'string' || !record.token) return null;
  return { url: record.url, token: record.token };
}

/** The URL a client on this machine uses to reach a daemon bound to `host`. */
export function daemonUrlFor(host: string, port: number): string {
  const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`;
}

/**
 * Probe the local daemon's /health. Returns null when it is not reachable.
 * Reads nothing from the vault, so it works whether or not one is unlocked.
 */
export async function getDaemonHealth(url: string = localDaemonUrl()): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/**
 * Where a call to a session goes. In remote mode, the hub, with this
 * machine's key. Otherwise the daemon on this machine, with the local token it
 * recorded. A session never runs in the CLI itself, so with no daemon there is
 * nothing to fall back to.
 */
export function sessionTarget(): { url: string; token: string; remote: boolean } {
  if (isRemoteMode()) return { url: hub().url, token: remoteToken()!, remote: true };
  const local = localDaemon();
  if (!local) throw daemonDownError();
  return { ...local, remote: false };
}

function daemonDownError(url?: string): CliError {
  return new CliError('NETWORK_ERROR', `The agentio daemon is not running${url ? ` at ${url}` : ' on this machine'}`, 'Run: agentio daemon start');
}

/**
 * One call to the daemon that holds the sessions. The hub's errors come back
 * as they are; the local daemon's are worded for the machine they happen on.
 */
export async function daemonCall<T>(path: string, options: Omit<HubCallOptions, 'token'> = {}): Promise<T> {
  const target = sessionTarget();
  try {
    return await hubCall<T>(target.url, path, { ...options, token: target.token });
  } catch (err) {
    if (target.remote || !(err instanceof CliError)) throw err;
    if (err.code === 'NETWORK_ERROR') throw daemonDownError(target.url);
    if (err.code === 'AUTH_FAILED') throw new CliError('AUTH_FAILED', 'The daemon did not accept its own local token', 'Restart it: agentio daemon start');
    if (err.code === 'CONFIG_ERROR' && err.message.startsWith('The vault is locked')) {
      throw new CliError('VAULT_LOCKED', "The daemon's vault is locked", `Unlock it at ${target.url}/ui`);
    }
    throw err;
  }
}

const profileRoute = (service: string, name: string) => `/v1/profiles/${encodeURIComponent(service)}/${encodeURIComponent(name)}`;

/** Rename a profile through the daemon, which moves its store and restarts its session. */
export function daemonRenameProfile(service: string, from: string, to: string): Promise<WriteOutcome> {
  return absentAsOutcome(daemonCall(profileRoute(service, from), { method: 'PATCH', body: { name: to } }));
}

/** Remove a profile through the daemon, which logs it out and deletes its store. */
export function daemonDeleteProfile(service: string, name: string): Promise<WriteOutcome> {
  return absentAsOutcome(daemonCall(profileRoute(service, name), { method: 'DELETE' }));
}
