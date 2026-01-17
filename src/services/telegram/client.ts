import type { TelegramBotInfo, TelegramChat, TelegramMessage, TelegramSendOptions } from '../../types/telegram';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramClient implements ServiceClient {
  private baseUrl: string;

  constructor(
    private botToken: string,
    private channelId: string
  ) {
    this.baseUrl = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const botInfo = await this.getMe();
      return { valid: true, info: `@${botInfo.username}` };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/${method}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: params ? JSON.stringify(params) : undefined,
      });

      const data = (await response.json()) as TelegramApiResponse<T>;

      if (!data.ok) {
        const errorMessage = data.description || 'Unknown Telegram API error';

        if (data.error_code === 401) {
          throw new CliError('AUTH_FAILED', `Invalid bot token: ${errorMessage}`);
        }
        if (data.error_code === 403) {
          throw new CliError('PERMISSION_DENIED', `Bot cannot access channel: ${errorMessage}`);
        }
        if (data.error_code === 404) {
          throw new CliError('NOT_FOUND', `Channel not found: ${errorMessage}`);
        }
        if (data.error_code === 429) {
          throw new CliError('RATE_LIMITED', `Rate limited: ${errorMessage}`);
        }

        throw new CliError('API_ERROR', `Telegram API error: ${errorMessage}`);
      }

      return data.result!;
    } catch (error) {
      if (error instanceof CliError) throw error;

      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new CliError('NETWORK_ERROR', `Failed to connect to Telegram: ${message}`);
    }
  }

  async getMe(): Promise<TelegramBotInfo> {
    return this.request<TelegramBotInfo>('getMe');
  }

  async getChat(chatId?: string): Promise<TelegramChat> {
    return this.request<TelegramChat>('getChat', {
      chat_id: chatId || this.channelId,
    });
  }

  async sendMessage(text: string, options?: TelegramSendOptions): Promise<TelegramMessage> {
    return this.request<TelegramMessage>('sendMessage', {
      chat_id: this.channelId,
      text,
      parse_mode: options?.parse_mode,
      disable_notification: options?.disable_notification,
    });
  }
}
