import { createHmac } from 'crypto';
import type { ServiceName } from '../types/config';
import type { WebhookPayload, GatewayConfig } from './types';

interface PendingMessage {
  id: string;
  service: ServiceName;
  profile: string;
  sender: string;
  preview: string;
}

let pendingMessages: PendingMessage[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let webhookConfig: GatewayConfig['webhook'] | null = null;

/**
 * Configure the webhook notifier
 */
export function configureWebhook(config: GatewayConfig['webhook']): void {
  webhookConfig = config;
}

/**
 * Queue a message for webhook notification
 * Messages are debounced to batch multiple notifications
 */
export function queueWebhookNotification(message: PendingMessage): void {
  if (!webhookConfig?.url) return;

  pendingMessages.push(message);

  // Clear existing timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Set new debounce timer
  const debounceMs = webhookConfig.debounceMs ?? 2000;
  debounceTimer = setTimeout(() => {
    sendWebhook();
  }, debounceMs);
}

/**
 * Send pending webhook notifications
 */
async function sendWebhook(): Promise<void> {
  if (!webhookConfig?.url || pendingMessages.length === 0) return;

  const messages = [...pendingMessages];
  pendingMessages = [];
  debounceTimer = null;

  const payload: WebhookPayload = {
    event: 'inbox.message',
    timestamp: Math.floor(Date.now() / 1000),
    messages,
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add HMAC signature if secret is configured
  if (webhookConfig.secret) {
    const signature = createHmac('sha256', webhookConfig.secret)
      .update(body)
      .digest('hex');
    headers['X-Agentio-Signature'] = `sha256=${signature}`;
  }

  try {
    const response = await fetch(webhookConfig.url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      console.error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error('Webhook error:', error instanceof Error ? error.message : error);
  }
}

/**
 * Flush any pending webhook notifications immediately
 */
export async function flushWebhook(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  await sendWebhook();
}

/**
 * Stop the webhook notifier
 */
export function stopWebhook(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingMessages = [];
  webhookConfig = null;
}
