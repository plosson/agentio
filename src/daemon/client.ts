import { readFileSync, unlinkSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { assertTestWritable, configDir } from '../vault/pointer';
import { DAEMON_PORT, type HealthResponse } from './types';

const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/** Where a running daemon was reached, as it recorded it on start. */
export interface DaemonRecord {
  url: string;
  pid: number;
}

/**
 * The daemon records its address here, so the CLI finds a daemon started on
 * another host or port (or on `--port 0`). Per HOME, like the vault pointer.
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
