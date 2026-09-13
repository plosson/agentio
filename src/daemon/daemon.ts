import { startApiServer, stopApiServer } from './api';
import { startKeepalive, stopKeepalive } from './keepalive';
import { getPassphrase, memoryOnlyProvider, setPassphraseProvider } from '../vault/passphrase';
import { unlockVault } from '../vault/vault';

/**
 * Start the daemon. Runs in the foreground and logs to stdout; process
 * supervision is the container runtime's job. The Bun.serve handle keeps
 * the process alive until a signal arrives.
 *
 * The daemon never reads the passphrase file. It starts locked unless
 * AGENTIO_PASSPHRASE is set, in which case the passphrase is verified
 * against the vault before the server comes up.
 *
 * Unlocking, here or at /ui, starts the token keepalive loop, and locking
 * stops it; see keepalive.ts for why that is the hub's job and nothing else's.
 */
export async function startDaemon(options: { version: string }): Promise<void> {
  console.log(`agentio-daemon starting (PID ${process.pid})`);

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    stopKeepalive();
    stopApiServer();
    console.log('Daemon stopped');
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

  startApiServer({ version: options.version });

  console.log('Daemon ready');
}
