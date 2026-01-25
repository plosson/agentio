import type { TelegramCredentials } from '../../types/telegram';
import type { ServiceName } from '../../types/config';
import { BaseAdapter, type AdapterInboundMessage, type AdapterOutboundMessage, type SendResult } from './types';

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const LONG_POLL_TIMEOUT = 30; // seconds

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessageObject;
  edited_message?: TelegramMessageObject;
  channel_post?: TelegramMessageObject;
  edited_channel_post?: TelegramMessageObject;
}

interface TelegramMessageObject {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  sender_chat?: {
    id: number;
    type: string;
    title?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: 'private' | 'group' | 'supergroup' | 'channel';
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  voice?: TelegramVoice;
  reply_to_message?: TelegramMessageObject;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_size?: number;
}

interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  file_size?: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
}

interface ProfileConnection {
  credentials: TelegramCredentials;
  lastUpdateId: number;
  abortController: AbortController | null;
  pollPromise: Promise<void> | null;
  shouldStop: boolean;
}

export class TelegramAdapter extends BaseAdapter {
  readonly service: ServiceName = 'telegram';

  private profiles: Map<string, ProfileConnection> = new Map();

  async connect(profile: string, credentials: unknown): Promise<void> {
    const creds = credentials as TelegramCredentials;

    // Stop existing connection if any
    await this.disconnect(profile);

    const connection: ProfileConnection = {
      credentials: creds,
      lastUpdateId: 0,
      abortController: null,
      pollPromise: null,
      shouldStop: false,
    };

    this.profiles.set(profile, connection);

    // Validate credentials first
    try {
      const baseUrl = `${TELEGRAM_API_BASE}${creds.botToken}`;
      const response = await fetch(`${baseUrl}/getMe`);
      const data = (await response.json()) as TelegramApiResponse<unknown>;

      if (!data.ok) {
        throw new Error(data.description || 'Invalid bot token');
      }

      this.setConnected(profile, true);
      console.log(`[telegram] Connected profile: ${profile}`);

      // Start long-polling
      this.startPolling(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      this.setConnected(profile, false, message);
      this.profiles.delete(profile);
      throw error;
    }
  }

  async disconnect(profile: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection) return;

    connection.shouldStop = true;

    // Abort any pending request
    if (connection.abortController) {
      connection.abortController.abort();
    }

    // Wait for poll to finish
    if (connection.pollPromise) {
      try {
        await connection.pollPromise;
      } catch {
        // Ignore abort errors
      }
    }

    this.profiles.delete(profile);
    this.connections.delete(profile);
    console.log(`[telegram] Disconnected profile: ${profile}`);
  }

  async disconnectAll(): Promise<void> {
    const profiles = Array.from(this.profiles.keys());
    await Promise.all(profiles.map((p) => this.disconnect(p)));
  }

  async send(profile: string, message: AdapterOutboundMessage): Promise<SendResult> {
    const connection = this.profiles.get(profile);
    if (!connection) {
      return { success: false, error: 'Profile not connected' };
    }

    const baseUrl = `${TELEGRAM_API_BASE}${connection.credentials.botToken}`;

    try {
      // Handle media if present
      if (message.mediaPath) {
        // For now, only support sending text
        // Media sending would require multipart form upload
        return { success: false, error: 'Media sending not yet implemented' };
      }

      const params: Record<string, unknown> = {
        chat_id: message.conversationId,
        text: message.content || '',
      };

      // Add reply reference if present
      if (message.replyToPlatformId) {
        params.reply_to_message_id = parseInt(message.replyToPlatformId, 10);
      }

      // Add parse mode from metadata
      if (message.metadata?.parse_mode) {
        params.parse_mode = message.metadata.parse_mode;
      }

      const response = await fetch(`${baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const data = (await response.json()) as TelegramApiResponse<TelegramMessageObject>;

      if (!data.ok) {
        return { success: false, error: data.description || 'Send failed' };
      }

      return {
        success: true,
        platformId: data.result!.message_id.toString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  private startPolling(profile: string): void {
    const connection = this.profiles.get(profile);
    if (!connection || connection.shouldStop) return;

    connection.pollPromise = this.poll(profile);
  }

  private async poll(profile: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection) return;

    while (!connection.shouldStop) {
      try {
        connection.abortController = new AbortController();

        const baseUrl = `${TELEGRAM_API_BASE}${connection.credentials.botToken}`;
        const params = new URLSearchParams({
          timeout: LONG_POLL_TIMEOUT.toString(),
          allowed_updates: JSON.stringify(['message', 'channel_post']),
        });

        if (connection.lastUpdateId > 0) {
          params.set('offset', (connection.lastUpdateId + 1).toString());
        }

        const response = await fetch(`${baseUrl}/getUpdates?${params}`, {
          signal: connection.abortController.signal,
        });

        const data = (await response.json()) as TelegramApiResponse<TelegramUpdate[]>;

        if (!data.ok) {
          console.error(`[telegram:${profile}] Poll error: ${data.description}`);
          this.setConnected(profile, false, data.description);
          await this.sleep(5000); // Wait before retry
          continue;
        }

        this.setConnected(profile, true);

        const updates = data.result || [];
        for (const update of updates) {
          connection.lastUpdateId = Math.max(connection.lastUpdateId, update.update_id);
          this.processUpdate(profile, update);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          break; // Normal shutdown
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[telegram:${profile}] Poll error: ${message}`);
        this.setConnected(profile, false, message);
        await this.sleep(5000); // Wait before retry
      }
    }
  }

  private processUpdate(profile: string, update: TelegramUpdate): void {
    // Handle regular messages and channel posts
    const msg = update.message || update.channel_post;
    if (!msg) return;

    // Determine sender info
    let senderId: string;
    let senderName: string | undefined;
    let senderHandle: string | undefined;

    if (msg.from) {
      senderId = msg.from.id.toString();
      senderName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
      senderHandle = msg.from.username;
    } else if (msg.sender_chat) {
      senderId = msg.sender_chat.id.toString();
      senderName = msg.sender_chat.title;
      senderHandle = msg.sender_chat.username;
    } else {
      senderId = msg.chat.id.toString();
      senderName = msg.chat.title || msg.chat.first_name;
      senderHandle = msg.chat.username;
    }

    // Determine media type
    let mediaType: AdapterInboundMessage['mediaType'];
    let mediaUrl: string | undefined;

    if (msg.photo && msg.photo.length > 0) {
      mediaType = 'image';
      // Get largest photo
      const largestPhoto = msg.photo.reduce((a, b) =>
        (a.file_size || 0) > (b.file_size || 0) ? a : b
      );
      mediaUrl = largestPhoto.file_id; // File ID, needs getFile call to download
    } else if (msg.video) {
      mediaType = 'video';
      mediaUrl = msg.video.file_id;
    } else if (msg.audio || msg.voice) {
      mediaType = 'audio';
      mediaUrl = (msg.audio || msg.voice)?.file_id;
    } else if (msg.document) {
      mediaType = 'document';
      mediaUrl = msg.document.file_id;
    }

    const inboundMessage: AdapterInboundMessage = {
      conversationId: msg.chat.id.toString(),
      platformId: msg.message_id.toString(),
      senderId,
      senderName,
      senderHandle,
      content: msg.text,
      mediaType,
      mediaUrl,
      receivedAt: msg.date * 1000, // Convert to milliseconds
      replyToId: msg.reply_to_message?.message_id.toString(),
      metadata: {
        chatType: msg.chat.type,
        chatTitle: msg.chat.title,
        updateId: update.update_id,
      },
    };

    this.emitMessage(profile, inboundMessage);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
