import { google } from 'googleapis';
import type { chat_v1 } from 'googleapis';
import { CliError } from '../../utils/errors';
import type { ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import type {
  GChatCredentials,
  GChatSendOptions,
  GChatSendResult,
  GChatListOptions,
  GChatGetOptions,
  GChatWebhookCredentials,
  GChatOAuthCredentials,
  GChatMessage,
} from '../../types/gchat';

export class GChatClient implements ServiceClient {
  private credentials: GChatCredentials;

  constructor(credentials: GChatCredentials) {
    this.credentials = credentials;
  }

  async validate(): Promise<ValidationResult> {
    if (this.credentials.type === 'webhook') {
      // Cannot validate webhooks without sending a message
      return { valid: true, info: 'webhook' };
    }

    try {
      const oauthCreds = this.credentials as GChatOAuthCredentials;
      const auth = this.createOAuthClient(oauthCreds);
      const chat = google.chat({ version: 'v1', auth });
      await chat.spaces.list({ pageSize: 1 });
      return { valid: true, info: 'oauth' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async send(options: GChatSendOptions & { spaceId?: string }): Promise<GChatSendResult> {
    if (this.credentials.type === 'webhook') {
      return this.sendViaWebhook(options);
    } else {
      return this.sendViaOAuth(options);
    }
  }

  async list(options: GChatListOptions): Promise<GChatMessage[]> {
    if (!options.spaceId?.trim()) {
      throw new CliError(
        'INVALID_PARAMS',
        'spaceId is required for listing messages',
        'Specify with --space or configure default in profile'
      );
    }
    if (this.credentials.type === 'webhook') {
      throw new CliError(
        'PERMISSION_DENIED',
        'List is not supported for webhook profiles',
        'Use an OAuth profile to read messages'
      );
    }
    return this.listViaOAuth(options);
  }

  async get(options: GChatGetOptions): Promise<GChatMessage> {
    if (!options.spaceId?.trim() || !options.messageId?.trim()) {
      throw new CliError(
        'INVALID_PARAMS',
        'Both spaceId and messageId are required',
        'Specify with --space and message ID'
      );
    }
    if (this.credentials.type === 'webhook') {
      throw new CliError(
        'PERMISSION_DENIED',
        'Get is not supported for webhook profiles',
        'Use an OAuth profile to read messages'
      );
    }
    return this.getViaOAuth(options);
  }

  private async sendViaWebhook(options: GChatSendOptions): Promise<GChatSendResult> {
    const webhookUrl = (this.credentials as GChatWebhookCredentials).webhookUrl;

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
          'API_ERROR',
          `Failed to send message via webhook: ${response.status} ${error}`,
          'Check that the webhook URL is valid and the bot has permission to post'
        );
      }

      // Parse response to extract message ID
      let messageId = 'unknown';
      try {
        const responseData = (await response.json()) as Record<string, unknown>;
        const messageName = responseData.name as string | undefined;
        if (messageName) {
          messageId = messageName.split('/').pop() || 'unknown';
        }
      } catch {
        // If response is not JSON or parsing fails, keep messageId as 'unknown'
        // The message was still sent successfully (response.ok was true)
      }

      return {
        messageId: messageId,
        text: options.text,
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

  private async sendViaOAuth(options: GChatSendOptions & { spaceId?: string }): Promise<GChatSendResult> {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = google.chat({ version: 'v1', auth });

    if (!options.spaceId) {
      throw new CliError(
        'INVALID_PARAMS',
        'spaceId is required for OAuth profiles',
        'Specify with --space or configure default in profile'
      );
    }

    // Use raw payload if provided, otherwise construct simple text message
    const requestBody = options.payload ?? { text: options.text };

    try {
      const response = await chat.spaces.messages.create({
        parent: `spaces/${options.spaceId}`,
        requestBody: requestBody as chat_v1.Schema$Message,
      });

      const messageId = response.data.name?.split('/').pop() || 'unknown';

      return {
        messageId: messageId,
        spaceId: options.spaceId,
        text: options.text,
        isJsonPayload: !!options.payload,
      };
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to send message: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  private async listViaOAuth(options: GChatListOptions): Promise<GChatMessage[]> {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = google.chat({ version: 'v1', auth });

    try {
      const response = await chat.spaces.messages.list({
        parent: `spaces/${options.spaceId}`,
        pageSize: options.limit || 10,
      });

      const messages = response.data.messages || [];
      return messages.map((msg: chat_v1.Schema$Message) => {
        const gchatMsg: GChatMessage = {
          name: msg.name || '',
          createTime: msg.createTime || new Date().toISOString(),
          // updateTime is not defined in chat_v1.Schema$Message, use lastUpdateTime as fallback
          updateTime: (msg as Record<string, unknown>).lastUpdateTime as string || new Date().toISOString(),
        };
        if (msg.text) gchatMsg.text = msg.text;
        if (msg.sender?.name) {
          gchatMsg.sender = {
            name: msg.sender.name,
            displayName: msg.sender.displayName || msg.sender.name,
          };
        }
        if (msg.thread?.name) {
          gchatMsg.thread = {
            name: msg.thread.name,
          };
        }
        return gchatMsg;
      });
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to list messages: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  private async getViaOAuth(options: GChatGetOptions): Promise<GChatMessage> {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = google.chat({ version: 'v1', auth });

    try {
      const response = await chat.spaces.messages.get({
        name: `spaces/${options.spaceId}/messages/${options.messageId}`,
      });

      if (!response.data) {
        throw new Error('Message not found');
      }

      const msg = response.data as chat_v1.Schema$Message;
      const gchatMsg: GChatMessage = {
        name: msg.name || '',
        createTime: msg.createTime || new Date().toISOString(),
        // updateTime is not defined in chat_v1.Schema$Message, use lastUpdateTime as fallback
        updateTime: (msg as Record<string, unknown>).lastUpdateTime as string || new Date().toISOString(),
      };
      if (msg.text) gchatMsg.text = msg.text;
      if (msg.sender?.name) {
        gchatMsg.sender = {
          name: msg.sender.name,
          displayName: msg.sender.displayName || msg.sender.name,
        };
      }
      if (msg.thread?.name) {
        gchatMsg.thread = {
          name: msg.thread.name,
        };
      }
      return gchatMsg;
    } catch (err) {
      const code = this.getErrorCode(err);
      const message = this.getErrorMessage(err);
      throw new CliError(
        code,
        `Failed to get message: ${message}`,
        'Check that the space ID and message ID are valid'
      );
    }
  }

  private getErrorCode(err: unknown): ErrorCode {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (code === 401) return 'AUTH_FAILED';
      if (code === 403) return 'PERMISSION_DENIED';
      if (code === 404) return 'NOT_FOUND';
      if (code === 429) return 'RATE_LIMITED';
    }
    return 'API_ERROR';
  }

  private getErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (code === 401) return 'OAuth token expired or invalid';
      if (code === 403) return 'Bot lacks permission for this operation';
      if (code === 404) return 'Space or message not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') {
        return error.message;
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  private createOAuthClient(credentials: GChatOAuthCredentials) {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_OAUTH_CONFIG.clientId,
      GOOGLE_OAUTH_CONFIG.clientSecret
    );

    oauth2Client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expiry_date: credentials.expiryDate,
    });

    return oauth2Client;
  }
}
