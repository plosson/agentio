import { join } from 'path';
import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import type { ServiceName } from '../types/config';
import type { GatewayConfig, DaemonState, DEFAULT_GATEWAY_CONFIG } from './types';
import { CONFIG_DIR, loadConfig } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { initDatabase, closeDatabase, insertInboxMessage, inboxMessageExists, getPendingOutboxMessages, updateOutboxStatus, cleanupInbox, cleanupOutbox } from './store';
import { startApiServer, stopApiServer } from './api';
import { configureWebhook, queueWebhookNotification, flushWebhook, stopWebhook } from './webhook';
import type { ServiceAdapter, AdapterInboundMessage } from './adapters/types';
import { TelegramAdapter } from './adapters/telegram';
import { WhatsAppAdapter } from './adapters/whatsapp';
import type { TelegramCredentials } from '../types/telegram';
import type { WhatsAppCredentials } from '../types/whatsapp';

const PID_FILE = join(CONFIG_DIR, 'gateway.pid');
const LOG_FILE = join(CONFIG_DIR, 'gateway.log');

let isRunning = false;
let shutdownRequested = false;
let adapters: Map<ServiceName, ServiceAdapter> = new Map();
let outboxInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Get the gateway configuration from config.json
 */
export async function getGatewayConfig(): Promise<GatewayConfig> {
  const config = await loadConfig();
  return (config as unknown as { gateway?: GatewayConfig }).gateway ?? {};
}

/**
 * Check if daemon is running
 */
export async function isDaemonRunning(): Promise<{ running: boolean; pid?: number }> {
  if (!existsSync(PID_FILE)) {
    return { running: false };
  }

  try {
    const pidStr = await readFile(PID_FILE, 'utf-8');
    const pid = parseInt(pidStr.trim(), 10);

    // Check if process is still running
    try {
      process.kill(pid, 0); // Doesn't kill, just checks
      return { running: true, pid };
    } catch {
      // Process not running, clean up stale PID file
      await unlink(PID_FILE).catch(() => {});
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

/**
 * Write PID file
 */
async function writePidFile(): Promise<void> {
  await writeFile(PID_FILE, process.pid.toString(), { mode: 0o600 });
}

/**
 * Remove PID file
 */
async function removePidFile(): Promise<void> {
  await unlink(PID_FILE).catch(() => {});
}

/**
 * Handle inbound message from adapter
 */
function handleInboundMessage(service: ServiceName, profile: string, message: AdapterInboundMessage): void {
  // Check for duplicates
  if (inboxMessageExists(service, profile, message.platformId)) {
    return;
  }

  // Insert into inbox
  const inboxMessage = insertInboxMessage({
    service,
    profile,
    conversationId: message.conversationId,
    platformId: message.platformId,
    senderId: message.senderId,
    senderName: message.senderName,
    senderHandle: message.senderHandle,
    content: message.content,
    mediaType: message.mediaType,
    mediaPath: message.mediaUrl, // Store URL for now, download later if needed
    receivedAt: message.receivedAt,
    replyToId: message.replyToId,
    metadata: message.metadata,
  });

  console.log(`[inbox] New message: ${service}:${profile} from ${message.senderName || message.senderId}`);

  // Queue webhook notification
  queueWebhookNotification({
    id: inboxMessage.id,
    service,
    profile,
    sender: message.senderName || message.senderHandle || message.senderId,
    preview: (message.content || '[media]').slice(0, 100),
  });
}

/**
 * Process outbox queue
 */
async function processOutbox(): Promise<void> {
  const pendingMessages = getPendingOutboxMessages({ limit: 10 });

  for (const message of pendingMessages) {
    const adapter = adapters.get(message.service);
    if (!adapter) {
      updateOutboxStatus(message.id, 'failed', { error: 'No adapter for service' });
      continue;
    }

    if (!adapter.isConnected(message.profile)) {
      // Skip, will retry later
      continue;
    }

    // Mark as sending
    updateOutboxStatus(message.id, 'sending');

    try {
      const result = await adapter.send(message.profile, {
        conversationId: message.conversationId,
        content: message.content,
        mediaPath: message.mediaPath,
        mediaType: message.mediaType,
        replyToPlatformId: message.replyToPlatformId,
        metadata: message.metadata,
      });

      if (result.success) {
        updateOutboxStatus(message.id, 'sent', { platformId: result.platformId });
        console.log(`[outbox] Sent: ${message.service}:${message.profile} -> ${message.conversationId}`);
      } else {
        updateOutboxStatus(message.id, 'failed', { error: result.error });
        console.error(`[outbox] Failed: ${message.service}:${message.profile} - ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      updateOutboxStatus(message.id, 'failed', { error: errorMessage });
      console.error(`[outbox] Error: ${message.service}:${message.profile} - ${errorMessage}`);
    }
  }
}

/**
 * Run retention cleanup
 */
async function runCleanup(config: GatewayConfig): Promise<void> {
  const retention = config.retention ?? {};

  if (retention.doneMessagesDays && retention.doneMessagesDays > 0) {
    const deleted = cleanupInbox(retention.doneMessagesDays);
    if (deleted > 0) {
      console.log(`[cleanup] Deleted ${deleted} old inbox messages`);
    }
  }

  if (retention.sentMessagesDays && retention.sentMessagesDays > 0) {
    const deleted = cleanupOutbox(retention.sentMessagesDays);
    if (deleted > 0) {
      console.log(`[cleanup] Deleted ${deleted} old outbox messages`);
    }
  }
}

/**
 * Initialize adapters based on configured profiles
 */
async function initializeAdapters(): Promise<void> {
  const config = await loadConfig();

  // Initialize Telegram adapter if profiles exist
  const telegramProfiles = config.profiles.telegram || [];
  if (telegramProfiles.length > 0) {
    const telegramAdapter = new TelegramAdapter();
    telegramAdapter.onMessage = (profile, message) => {
      handleInboundMessage('telegram', profile, message);
    };

    for (const profile of telegramProfiles) {
      try {
        const credentials = await getCredentials<TelegramCredentials>('telegram', profile);
        if (credentials) {
          await telegramAdapter.connect(profile, credentials);
        } else {
          console.error(`[telegram] No credentials for profile: ${profile}`);
        }
      } catch (error) {
        console.error(`[telegram] Failed to connect ${profile}:`, error instanceof Error ? error.message : error);
      }
    }

    adapters.set('telegram', telegramAdapter);
  }

  // Initialize WhatsApp adapter if profiles exist
  const whatsappProfiles = config.profiles.whatsapp || [];
  if (whatsappProfiles.length > 0) {
    const whatsappAdapter = new WhatsAppAdapter();
    whatsappAdapter.onMessage = (profile, message) => {
      handleInboundMessage('whatsapp', profile, message);
    };

    for (const profile of whatsappProfiles) {
      try {
        const credentials = await getCredentials<WhatsAppCredentials>('whatsapp', profile);
        if (credentials) {
          await whatsappAdapter.connect(profile, credentials);
        } else {
          console.error(`[whatsapp] No credentials for profile: ${profile}`);
        }
      } catch (error) {
        console.error(`[whatsapp] Failed to connect ${profile}:`, error instanceof Error ? error.message : error);
      }
    }

    adapters.set('whatsapp', whatsappAdapter);
  }
}

/**
 * Shutdown all adapters
 */
async function shutdownAdapters(): Promise<void> {
  for (const [service, adapter] of adapters) {
    try {
      await adapter.disconnectAll();
      console.log(`[${service}] Disconnected all profiles`);
    } catch (error) {
      console.error(`[${service}] Shutdown error:`, error instanceof Error ? error.message : error);
    }
  }
  adapters.clear();
}

/**
 * Start the gateway daemon
 */
export async function startDaemon(options: { foreground?: boolean } = {}): Promise<void> {
  // Check if already running
  const status = await isDaemonRunning();
  if (status.running) {
    throw new Error(`Gateway already running (PID ${status.pid})`);
  }

  if (!options.foreground) {
    // Fork to background
    // Find the script path - handle both direct invocation and 'bun run' cases
    let scriptPath = process.argv[1];

    // If invoked via 'bun run', argv[1] is 'run' and we need to find the actual script
    if (scriptPath === 'run') {
      // Find src/index.ts in argv or use default
      const scriptIndex = process.argv.findIndex(arg => arg.endsWith('index.ts') || arg.endsWith('index.js'));
      if (scriptIndex !== -1) {
        scriptPath = process.argv[scriptIndex];
      } else {
        // Fallback: use the package.json bin entry path relative to cwd
        scriptPath = join(process.cwd(), 'src', 'index.ts');
      }
    }

    const child = spawn(process.execPath, [scriptPath, 'gateway', 'start', '--foreground'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    // Write logs to file
    const logStream = Bun.file(LOG_FILE).writer();
    child.stdout?.on('data', (data) => logStream.write(data));
    child.stderr?.on('data', (data) => logStream.write(data));

    child.unref();
    console.log(`Gateway started in background (PID ${child.pid})`);
    console.log(`Logs: ${LOG_FILE}`);
    return;
  }

  // Running in foreground
  isRunning = true;
  console.log(`Gateway starting (PID ${process.pid})`);

  // Handle shutdown signals
  const shutdown = async (signal: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;

    console.log(`\nReceived ${signal}, shutting down...`);

    // Stop intervals
    if (outboxInterval) clearInterval(outboxInterval);
    if (cleanupInterval) clearInterval(cleanupInterval);

    // Flush webhooks
    await flushWebhook();
    stopWebhook();

    // Shutdown adapters
    await shutdownAdapters();

    // Stop API server
    stopApiServer();

    // Close database
    closeDatabase();

    // Remove PID file
    await removePidFile();

    console.log('Gateway stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Write PID file
    await writePidFile();

    // Load config
    const gatewayConfig = await getGatewayConfig();

    // Initialize database
    await initDatabase();
    console.log('Database initialized');

    // Configure webhook
    if (gatewayConfig.webhook?.url) {
      configureWebhook(gatewayConfig.webhook);
      console.log(`Webhook configured: ${gatewayConfig.webhook.url}`);
    }

    // Initialize adapters
    await initializeAdapters();

    // Start API server
    startApiServer(gatewayConfig.api, adapters);

    // Start outbox processor (every 2 seconds)
    outboxInterval = setInterval(processOutbox, 2000);

    // Start cleanup job (every hour)
    cleanupInterval = setInterval(() => runCleanup(gatewayConfig), 60 * 60 * 1000);

    console.log('Gateway ready');

    // Keep running
    await new Promise(() => {}); // Wait forever
  } catch (error) {
    console.error('Gateway error:', error instanceof Error ? error.message : error);
    await removePidFile();
    process.exit(1);
  }
}

/**
 * Stop the gateway daemon
 */
export async function stopDaemon(): Promise<void> {
  const status = await isDaemonRunning();
  if (!status.running || !status.pid) {
    console.log('Gateway is not running');
    return;
  }

  try {
    process.kill(status.pid, 'SIGTERM');
    console.log(`Sent SIGTERM to gateway (PID ${status.pid})`);

    // Wait for process to stop
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(status.pid, 0);
      } catch {
        console.log('Gateway stopped');
        return;
      }
    }

    // Force kill if still running
    try {
      process.kill(status.pid, 'SIGKILL');
      console.log('Gateway force killed');
    } catch {
      console.log('Gateway stopped');
    }
  } catch (error) {
    console.error('Failed to stop gateway:', error instanceof Error ? error.message : error);
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<{
  running: boolean;
  pid?: number;
  adapters?: { service: string; profile: string; connected: boolean }[];
}> {
  const status = await isDaemonRunning();
  if (!status.running) {
    return { running: false };
  }

  // Try to get status from API
  const gatewayConfig = await getGatewayConfig();
  const port = gatewayConfig.api?.port ?? 7890;
  const host = gatewayConfig.api?.host ?? '127.0.0.1';

  try {
    const response = await fetch(`http://${host}:${port}/status`, {
      headers: gatewayConfig.api?.secret ? { Authorization: `Bearer ${gatewayConfig.api.secret}` } : {},
    });

    if (response.ok) {
      const data = await response.json() as { adapters: { service: string; profile: string; connected: boolean }[] };
      return {
        running: true,
        pid: status.pid,
        adapters: data.adapters,
      };
    }
  } catch {
    // API not responding, but process exists
  }

  return { running: true, pid: status.pid };
}

/**
 * Reload daemon configuration
 */
export async function reloadDaemon(): Promise<void> {
  const status = await isDaemonRunning();
  if (!status.running || !status.pid) {
    throw new Error('Gateway is not running');
  }

  // Send SIGHUP to trigger reload
  process.kill(status.pid, 'SIGHUP');
  console.log(`Sent reload signal to gateway (PID ${status.pid})`);
}

export { PID_FILE, LOG_FILE };
