import { startApiServer, stopApiServer } from './api';
import { daemonUrlFor, forgetDaemon, recordDaemon } from './client';
import { startKeepalive, stopKeepalive } from './keepalive';
import { DAEMON_HOST, DAEMON_PORT, type DaemonAddress } from './types';
import { getPassphrase, memoryOnlyProvider, setPassphraseProvider } from '../vault/passphrase';
import { isVaultUnlocked, unlockVault } from '../vault/vault';
import { CliError } from '../utils/errors';
import { printJson } from '../utils/output';

/**
 * The address from `--host`/`--port`, else AGENTIO_DAEMON_HOST/AGENTIO_DAEMON_PORT,
 * else 0.0.0.0:7890, which is what the container image relies on.
 */
export function resolveDaemonAddress(
  options: { host?: string; port?: string },
  env: Record<string, string | undefined> = process.env,
): DaemonAddress {
  const host = (options.host ?? (env.AGENTIO_DAEMON_HOST || DAEMON_HOST)).trim();
  if (!host) {
    throw new CliError('INVALID_PARAMS', 'The daemon host is empty', 'Use --host 127.0.0.1 to listen on this machine only');
  }
  const rawPort = (options.port ?? (env.AGENTIO_DAEMON_PORT || String(DAEMON_PORT))).trim();
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) {
    throw new CliError('INVALID_PARAMS', `Invalid daemon port: ${rawPort}`, 'Use a number from 0 to 65535; 0 lets the system pick a free port');
  }
  return { host, port: Number(rawPort) };
}

/**
 * Start the daemon. Runs in the foreground and logs to stdout; process
 * supervision is the container runtime's job. The Bun.serve handle keeps
 * the process alive until a signal arrives.
 *
 * With `json`, stdout carries only events: one `listening` once the server is
 * up, and `stopped` on shutdown. JSON mode sends the log to stderr.
 *
 * The daemon never reads the passphrase file. It starts locked unless
 * AGENTIO_PASSPHRASE is set, in which case the passphrase is verified
 * against the vault before the server comes up.
 *
 * Unlocking, here or at /ui, starts the token keepalive loop, and locking
 * stops it; see keepalive.ts for why that is the hub's job and nothing else's.
 */
export async function startDaemon(options: { version: string; address: DaemonAddress; json?: boolean }): Promise<void> {
  const { host } = options.address;
  console.log(`agentio-daemon starting (PID ${process.pid})`);

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    stopKeepalive();
    stopApiServer();
    forgetDaemon(process.pid);
    console.log('Daemon stopped');
    if (options.json) printJson({ event: 'stopped' });
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // With the memory-only provider installed, getPassphrase() yields the
  // env var or nothing. Once verified, the env var is dropped so the resident
  // copy is the single source of lock state and lockVault() can undo it.
  setPassphraseProvider(memoryOnlyProvider());
  const envPassphrase = await getPassphrase();
  if (envPassphrase) {
    await unlockVault(envPassphrase);
    delete process.env.AGENTIO_PASSPHRASE;
    console.log('Vault unlocked from AGENTIO_PASSPHRASE');
    startKeepalive();
  } else {
    // Nothing to refresh while locked; unlocking at /ui starts the loop.
    console.log('Vault is locked');
  }

  let port: number;
  try {
    port = startApiServer({ version: options.version }, options.address);
  } catch (error) {
    stopKeepalive();
    throw new CliError(
      'CONFIG_ERROR',
      `Cannot listen on ${host}:${options.address.port}: ${error instanceof Error ? error.message : String(error)}`,
      'Pick another port with --port (0 picks a free one), or stop what is using it',
    );
  }
  const url = daemonUrlFor(host, port);
  console.log(`Daemon API listening on ${host}:${port}`);
  console.log(`Admin UI at ${url}/ui`);

  try {
    await recordDaemon({ url, pid: process.pid });
  } catch (error) {
    // The daemon still serves; only `daemon status` falls back to the default address.
    console.error(`Could not record the daemon address: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.json) printJson({ event: 'listening', url, locked: !isVaultUnlocked() });
  console.log('Daemon ready');
}
