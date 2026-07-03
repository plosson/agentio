import { join } from 'path';
import { randomBytes } from 'crypto';
import type { Config, DaemonConfig } from '../types/config';
import { startScheduler, stopScheduler } from './scheduler';
import { CONFIG_DIR, loadConfig, saveConfig } from '../config/config-manager';
import { startApiServer, stopApiServer } from './api';
import { migrateLegacyFiles } from './path-migration';

const LOG_FILE = join(CONFIG_DIR, 'daemon.log');

let shutdownRequested = false;

/**
 * Start the daemon (runs in foreground, managed by launchd on macOS / systemd on Linux).
 */
export async function startDaemon(): Promise<void> {
  console.log(`agentio-daemon starting (PID ${process.pid})`);

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;

    console.log(`\nReceived ${signal}, shutting down...`);

    // Stop scheduler
    await stopScheduler();

    // Stop API server
    stopApiServer();

    console.log('Daemon stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
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

    // Migrate legacy gateway.* files to daemon.*
    migrateLegacyFiles(CONFIG_DIR);

    // Start API server (health + scheduler control)
    startApiServer(daemonConfig);

    // Start scheduler
    const schedulerConfig = daemonConfig.scheduler;
    const folders = schedulerConfig?.watchedFolders ?? [];
    const tickMs = (schedulerConfig?.tickIntervalSec ?? 60) * 1000;
    await startScheduler({
      watchedFolders: folders,
      tickIntervalMs: tickMs,
    });
    console.log(`[scheduler] watching ${folders.length} folder(s), tick=${tickMs}ms`);

    console.log('Daemon ready');

    // Keep running
    await new Promise(() => {}); // Wait forever
  } catch (error) {
    console.error('Daemon error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export { LOG_FILE };
