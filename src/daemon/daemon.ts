import { startApiServer, stopApiServer } from './api';
import { memoryOnlyProvider, setPassphraseProvider } from '../vault/passphrase';
import { unlockVault } from '../vault/vault';

/**
 * Start the daemon. Runs in the foreground and logs to stdout; process
 * supervision is the container runtime's job. The Bun.serve handle keeps
 * the process alive until a signal arrives.
 *
 * The daemon never reads the passphrase file. It starts locked unless
 * AGENTIO_PASSPHRASE is set, in which case the passphrase is verified
 * against the vault before the server comes up.
 */
export async function startDaemon(): Promise<void> {
  console.log(`agentio-daemon starting (PID ${process.pid})`);

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    stopApiServer();
    console.log('Daemon stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  setPassphraseProvider(memoryOnlyProvider());

  const envPassphrase = process.env.AGENTIO_PASSPHRASE;
  if (envPassphrase) {
    await unlockVault(envPassphrase);
    console.log('Vault unlocked from AGENTIO_PASSPHRASE');
  } else {
    console.log('Vault is locked; waiting for an unlock');
  }

  startApiServer();

  console.log('Daemon ready');
}
