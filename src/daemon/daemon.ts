import { randomBytes } from 'crypto';
import type { Config, DaemonConfig } from '../types/config';
import { loadConfig, saveConfig } from '../config/config-manager';
import { startApiServer, stopApiServer } from './api';

/**
 * Start the daemon. Runs in the foreground and logs to stdout; process
 * supervision is the container runtime's job. The Bun.serve handle keeps
 * the process alive until a signal arrives.
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

  // Load config and auto-generate API key on first run
  const config = await loadConfig() as Config;
  let daemonConfig: DaemonConfig = config.daemon ?? {};

  if (!daemonConfig.apiKey) {
    const generatedKey = `gw_${randomBytes(24).toString('base64url')}`;
    daemonConfig = {
      ...daemonConfig,
      apiKey: generatedKey,
    };
    config.daemon = daemonConfig;
    await saveConfig(config);
  }

  // Always display API key for easy access (e.g., Docker logs)
  console.log(`API Key: ${daemonConfig.apiKey}`);

  // Start API server (health endpoint; future vault UI/API home)
  startApiServer(daemonConfig);

  console.log('Daemon ready');
}
