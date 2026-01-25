import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type ConnectionState,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import type {
  WhatsAppCredentials,
  WhatsAppMessage,
  WhatsAppSendOptions,
  WhatsAppSendResult,
  WhatsAppChat,
  WhatsAppListOptions,
} from '../../types/whatsapp';
import { CliError } from '../../utils/errors';

// Suppress Baileys logging in production
const logger = {
  level: 'silent' as const,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => logger,
};

export class WhatsAppClient {
  private credentials: WhatsAppCredentials;
  private socket: WASocket | null = null;
  private connectionPromise: Promise<void> | null = null;

  constructor(credentials: WhatsAppCredentials) {
    this.credentials = credentials;
  }

  private normalizePhoneNumber(phone: string): string {
    // Remove all non-digit characters except +
    let normalized = phone.replace(/[^\d+]/g, '');
    // Remove leading + if present
    if (normalized.startsWith('+')) {
      normalized = normalized.slice(1);
    }
    return normalized;
  }

  private toJid(recipient: string): string {
    // If already a JID, return as-is
    if (recipient.includes('@')) {
      return recipient;
    }
    // Otherwise, treat as phone number
    const normalized = this.normalizePhoneNumber(recipient);
    return `${normalized}@s.whatsapp.net`;
  }

  async connect(): Promise<WASocket> {
    if (this.socket) {
      return this.socket;
    }

    const authPath = this.credentials.authStatePath;

    // Ensure auth directory exists
    if (!existsSync(authPath)) {
      throw new CliError(
        'AUTH_FAILED',
        'WhatsApp session not found',
        'Run: agentio whatsapp profile add'
      );
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    return new Promise((resolve, reject) => {
      const socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        logger,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      const connectionTimeout = setTimeout(() => {
        socket.end(new Error('Connection timeout'));
        reject(new CliError('NETWORK_ERROR', 'Connection timeout', 'Check your network connection'));
      }, 30000);

      socket.ev.on('creds.update', saveCreds);

      socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          clearTimeout(connectionTimeout);
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

          if (statusCode === DisconnectReason.loggedOut) {
            reject(new CliError('AUTH_FAILED', 'Session logged out', 'Run: agentio whatsapp profile add'));
          } else {
            const reason = statusCode !== undefined ? `code ${statusCode}` : 'Unknown';
            reject(new CliError('NETWORK_ERROR', `Connection closed: ${reason}`));
          }
        } else if (connection === 'open') {
          clearTimeout(connectionTimeout);
          this.socket = socket;
          resolve(socket);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
  }

  async send(options: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
    const socket = await this.connect();
    const jid = this.toJid(options.to);

    try {
      let result;

      if (options.mediaPath) {
        // Send media with optional caption
        const { readFile, stat } = await import('fs/promises');
        const { basename, extname } = await import('path');

        const mediaBuffer = await readFile(options.mediaPath);
        const fileName = basename(options.mediaPath);
        const ext = extname(options.mediaPath).toLowerCase();

        // Determine media type from extension
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
        const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.opus'];

        if (imageExts.includes(ext)) {
          result = await socket.sendMessage(jid, {
            image: mediaBuffer,
            caption: options.caption || options.text,
          });
        } else if (videoExts.includes(ext)) {
          result = await socket.sendMessage(jid, {
            video: mediaBuffer,
            caption: options.caption || options.text,
          });
        } else if (audioExts.includes(ext)) {
          result = await socket.sendMessage(jid, {
            audio: mediaBuffer,
            mimetype: 'audio/mp4',
          });
        } else {
          // Send as document - determine mimetype from extension
          const mimeTypes: Record<string, string> = {
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.txt': 'text/plain',
            '.zip': 'application/zip',
            '.json': 'application/json',
          };
          const mimetype = mimeTypes[ext] || 'application/octet-stream';

          result = await socket.sendMessage(jid, {
            document: mediaBuffer,
            mimetype,
            fileName,
            caption: options.caption || options.text,
          });
        }
      } else if (options.text) {
        result = await socket.sendMessage(jid, { text: options.text });
      } else {
        throw new CliError('INVALID_PARAMS', 'Either text or mediaPath is required');
      }

      if (!result) {
        throw new CliError('API_ERROR', 'Failed to send message');
      }

      return {
        messageId: result.key.id || 'unknown',
        to: jid,
        timestamp: result.messageTimestamp as number || Date.now() / 1000,
      };
    } finally {
      await this.disconnect();
    }
  }

  async getChats(options?: WhatsAppListOptions): Promise<WhatsAppChat[]> {
    const socket = await this.connect();

    try {
      // Wait a moment for store to sync
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const store = (socket as any).store;
      const chats: WhatsAppChat[] = [];

      // Get chats from the socket's internal state
      const chatList = await socket.groupFetchAllParticipating();

      // Add groups
      for (const [id, group] of Object.entries(chatList)) {
        chats.push({
          id,
          name: group.subject,
          isGroup: true,
          unreadCount: 0,
          lastMessageTime: group.subjectTime || undefined,
        });
      }

      // Sort by last message time and apply limit
      chats.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
      const limit = options?.limit || 20;

      return chats.slice(0, limit);
    } finally {
      await this.disconnect();
    }
  }

  async checkNumberExists(phone: string): Promise<{ exists: boolean; jid?: string }> {
    const socket = await this.connect();
    const jid = this.toJid(phone);

    try {
      const results = await socket.onWhatsApp(jid);
      const result = results?.[0];
      return {
        exists: result?.exists || false,
        jid: result?.jid,
      };
    } finally {
      await this.disconnect();
    }
  }
}

// Helper to create a new WhatsApp session via QR code
export async function createWhatsAppSession(
  authPath: string,
  onQRCode: (qr: string) => void,
  onConnected: (pushName: string) => void
): Promise<void> {
  // Ensure auth directory exists
  await mkdir(authPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    const connectionTimeout = setTimeout(() => {
      socket.end(new Error('Connection timeout'));
      reject(new CliError('NETWORK_ERROR', 'QR code expired or connection timeout', 'Try again'));
    }, 120000); // 2 minutes for QR scan

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        onQRCode(qr);
      }

      if (connection === 'close') {
        clearTimeout(connectionTimeout);
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          reject(new CliError('AUTH_FAILED', 'Session was logged out'));
        } else if (statusCode !== DisconnectReason.restartRequired) {
          reject(new CliError('NETWORK_ERROR', 'Connection failed during setup'));
        }
      } else if (connection === 'open') {
        clearTimeout(connectionTimeout);
        const pushName = socket.user?.name || 'Unknown';
        onConnected(pushName);
        socket.end(undefined);
        resolve();
      }
    });
  });
}
