import { CliError } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import type {
  SlackCredentials,
  SlackSendOptions,
  SlackSendResult,
  SlackWebhookCredentials,
} from '../../types/slack';

export class SlackClient implements ServiceClient {
  private credentials: SlackCredentials;

  constructor(credentials: SlackCredentials) {
    this.credentials = credentials;
  }

  async validate(): Promise<ValidationResult> {
    // Webhooks cannot be validated without sending a message
    const webhookCreds = this.credentials as SlackWebhookCredentials;
    const info = webhookCreds.channelName ? `#${webhookCreds.channelName}` : 'webhook (not testable)';
    return { valid: true, info };
  }

  async send(options: SlackSendOptions): Promise<SlackSendResult> {
    if (this.credentials.type === 'webhook') {
      return this.sendViaWebhook(options);
    }
    throw new CliError('INVALID_PARAMS', 'Unknown credentials type');
  }

  private async sendViaWebhook(options: SlackSendOptions): Promise<SlackSendResult> {
    const webhookUrl = (this.credentials as SlackWebhookCredentials).webhookUrl;

    if (!webhookUrl?.trim() || !webhookUrl.startsWith('https://')) {
      throw new CliError(
        'INVALID_PARAMS',
        'Invalid webhook URL - must be HTTPS',
        'Check the webhook URL configuration'
      );
    }

    // Use raw payload if provided, otherwise construct simple text message
    const payload = options.payload ?? { text: options.text };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new CliError(
          this.getErrorCode(response.status),
          `Failed to send message via webhook: ${response.status} ${error}`,
          'Check that the webhook URL is valid and the app has permission to post'
        );
      }

      return {
        success: true,
        isJsonPayload: !!options.payload,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        'NETWORK_ERROR',
        `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the webhook URL is correct and accessible'
      );
    }
  }

  private getErrorCode(status: number): 'AUTH_FAILED' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'API_ERROR' {
    if (status === 401) return 'AUTH_FAILED';
    if (status === 403) return 'PERMISSION_DENIED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    return 'API_ERROR';
  }
}
