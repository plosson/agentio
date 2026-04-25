import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import type { ServiceName, Config, DaemonConfig } from '../types/config';
import { startScheduler, stopScheduler } from './scheduler';
import { CONFIG_DIR, loadConfig, saveConfig } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { initDatabase, closeDatabase, insertInboxMessage, inboxMessageExists, getPendingOutboxMessages, updateOutboxStatus, cleanupInbox, cleanupOutbox } from './store';
import { startApiServer, stopApiServer } from './api';
import { configureWebhook, queueWebhookNotification, flushWebhook, stopWebhook } from './webhook';
import type { ServiceAdapter, AdapterInboundMessage } from './adapters/types';
import { TelegramAdapter } from './adapters/telegram';
import { WhatsAppAdapter } from './adapters/whatsapp';
import type { TelegramCredentials } from '../types/telegram';
import type { WhatsAppCredentials } from '../types/whatsapp';
import { migrateLegacyFiles } from './path-migration';

const LOG_FILE = join(CONFIG_DIR, 'daemon.log');

let shutdownRequested = false;
let adapters: Map<ServiceName, ServiceAdapter> = new Map();
let outboxInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Get the daemon configuration from the vault.
 */
export async function getDaemonConfig(): Promise<DaemonConfig> {
  const config = await loadConfig();
  return config.daemon ?? {};
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
async function runCleanup(config: DaemonConfig): Promise<void> {
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

    for (const entry of telegramProfiles) {
      const profileName = typeof entry === 'string' ? entry : entry.name;
      try {
        const credentials = await getCredentials<TelegramCredentials>('telegram', profileName);
        if (credentials) {
          await telegramAdapter.connect(profileName, credentials);
        } else {
          console.error(`[telegram] No credentials for profile: ${profileName}`);
        }
      } catch (error) {
        console.error(`[telegram] Failed to connect ${profileName}:`, error instanceof Error ? error.message : error);
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

    for (const entry of whatsappProfiles) {
      const profileName = typeof entry === 'string' ? entry : entry.name;
      try {
        const credentials = await getCredentials<WhatsAppCredentials>('whatsapp', profileName);
        if (credentials) {
          await whatsappAdapter.connect(profileName, credentials);
        } else {
          console.error(`[whatsapp] No credentials for profile: ${profileName}`);
        }
      } catch (error) {
        console.error(`[whatsapp] Failed to connect ${profileName}:`, error instanceof Error ? error.message : error);
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
 * Start the daemon (runs in foreground, managed by launchd on macOS / systemd on Linux).
 */
export async function startDaemon(): Promise<void> {
  console.log(`agentio-daemon starting (PID ${process.pid})`);

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

    // Stop scheduler
    await stopScheduler();

    // Shutdown adapters
    await shutdownAdapters();

    // Stop API server
    stopApiServer();

    // Close database
    closeDatabase();

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

    // Detect legacy per-schedule launchd plists (macOS only)
    if (process.platform === 'darwin') {
      try {
        const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
        if (existsSync(launchAgentsDir)) {
          const legacy = readdirSync(launchAgentsDir)
            .filter((f) => f.startsWith('me.agentio.schedule.') && f.endsWith('.plist'));
          if (legacy.length > 0) {
            console.log(`[migration] Found ${legacy.length} legacy schedule plist(s).`);
            console.log('[migration] Run: agentio schedule migrate');
          }
        }
      } catch { /* non-fatal */ }
    }

    // Initialize database
    await initDatabase();
    console.log('Database initialized');

    // Configure webhook
    if (daemonConfig.webhook?.url) {
      configureWebhook(daemonConfig.webhook);
      console.log(`Webhook configured: ${daemonConfig.webhook.url}`);
    }

    // Initialize adapters
    await initializeAdapters();

    // Start API server
    startApiServer(daemonConfig, adapters, handleInboundMessage);

    // Start outbox processor (every 2 seconds)
    outboxInterval = setInterval(processOutbox, 2000);

    // Start cleanup job (every hour)
    cleanupInterval = setInterval(() => runCleanup(daemonConfig), 60 * 60 * 1000);

    // Start scheduler
    const schedulerConfig = daemonConfig.scheduler;
    const folders = schedulerConfig?.watchedFolders ?? [];
    if (folders.length > 0) {
      const tickMs = (schedulerConfig?.tickIntervalSec ?? 60) * 1000;
      await startScheduler({
        watchedFolders: folders,
        tickIntervalMs: tickMs,
      });
      console.log(`[scheduler] watching ${folders.length} folder(s), tick=${tickMs}ms`);
    } else {
      console.log('[scheduler] no watched folders');
    }

    console.log('Daemon ready');

    // Keep running
    await new Promise(() => {}); // Wait forever
  } catch (error) {
    console.error('Daemon error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export { LOG_FILE };
