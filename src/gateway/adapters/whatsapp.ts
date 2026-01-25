import makeWASocket, {
  DisconnectReason,
  WASocket,
  ConnectionState,
  WAMessage,
  MessageUpsertType,
  jidNormalizedUser,
  isJidGroup,
  getContentType,
} from '@whiskeysockets/baileys';
import type { ServiceName } from '../../types/config';
import type { WhatsAppCredentials } from '../../types/whatsapp';
import { BaseAdapter, type AdapterInboundMessage, type AdapterOutboundMessage, type SendResult, type ConnectionState as AdapterConnectionState } from './types';
import { useSQLiteAuthState, hasAuthState } from './whatsapp-auth';

interface ProfileConnection {
  socket: WASocket | null;
  credentials: WhatsAppCredentials;
  authState: Awaited<ReturnType<typeof useSQLiteAuthState>> | null;
  qrCode: string | null;
  shouldStop: boolean;
  reconnectAttempts: number;
}

// Extract phone number from JID
function jidToPhone(jid: string): string {
  const normalized = jidNormalizedUser(jid);
  return normalized.split('@')[0];
}

// Convert phone number to JID
function phoneToJid(phone: string): string {
  // Remove any non-digit characters except leading +
  const cleaned = phone.replace(/[^\d]/g, '');
  return `${cleaned}@s.whatsapp.net`;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly service: ServiceName = 'whatsapp';

  private profiles: Map<string, ProfileConnection> = new Map();

  async connect(profile: string, credentials: unknown): Promise<void> {
    const creds = credentials as WhatsAppCredentials;

    // Stop existing connection if any
    await this.disconnect(profile);

    const connection: ProfileConnection = {
      socket: null,
      credentials: creds,
      authState: null,
      qrCode: null,
      shouldStop: false,
      reconnectAttempts: 0,
    };

    this.profiles.set(profile, connection);

    try {
      // Initialize auth state from SQLite
      const authState = await useSQLiteAuthState(profile);
      connection.authState = authState;

      await this.createSocket(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      this.setConnected(profile, false, message);
      this.profiles.delete(profile);
      throw error;
    }
  }

  private async createSocket(profile: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection || !connection.authState) return;

    const { state, saveCreds } = connection.authState;

    // Create a silent logger that satisfies Baileys' requirements
    const silentLogger: any = {
      level: 'silent',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: console.warn,
      error: console.error,
      fatal: console.error,
    };
    // child() must return a logger with all methods
    silentLogger.child = () => silentLogger;

    // Create socket with auth state
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false, // We'll handle QR ourselves
      browser: ['agentio', 'Chrome', '120.0.0'],
      logger: silentLogger,
    });

    connection.socket = socket;

    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(profile, update);
    });

    // Handle credential updates
    socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    socket.ev.on('messages.upsert', (upsert) => {
      this.handleMessagesUpsert(profile, upsert);
    });
  }

  private async handleConnectionUpdate(profile: string, update: Partial<ConnectionState>): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection) return;

    const { connection: connState, lastDisconnect, qr } = update;

    // Handle QR code
    if (qr) {
      connection.qrCode = qr;
      console.log(`[whatsapp:${profile}] Scan QR code to connect`);
      // In a real implementation, you'd want to emit this to a pairing endpoint
    }

    if (connState === 'open') {
      connection.qrCode = null;
      connection.reconnectAttempts = 0;
      this.setConnected(profile, true);

      // Update credentials with phone number if available
      const user = connection.socket?.user;
      if (user) {
        connection.credentials.phoneNumber = jidToPhone(user.id);
        connection.credentials.displayName = user.name || user.verifiedName;
        connection.credentials.paired = true;
        connection.credentials.lastConnected = Date.now();
      }

      console.log(`[whatsapp:${profile}] Connected as ${connection.credentials.phoneNumber || 'unknown'}`);
    }

    if (connState === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[whatsapp:${profile}] Logged out, clearing session`);
        connection.credentials.paired = false;
        if (connection.authState) {
          await connection.authState.clearState();
        }
        this.setConnected(profile, false, 'Logged out');
      } else if (shouldReconnect && !connection.shouldStop) {
        connection.reconnectAttempts++;
        const delay = Math.min(connection.reconnectAttempts * 2000, 30000);
        console.log(`[whatsapp:${profile}] Reconnecting in ${delay / 1000}s...`);
        this.setConnected(profile, false, 'Reconnecting...');

        setTimeout(() => {
          if (!connection.shouldStop) {
            this.createSocket(profile);
          }
        }, delay);
      } else {
        this.setConnected(profile, false, 'Disconnected');
      }
    }
  }

  private handleMessagesUpsert(profile: string, upsert: { messages: WAMessage[]; type: MessageUpsertType }): void {
    const connection = this.profiles.get(profile);
    if (!connection) return;

    // Only process new messages (not history sync)
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
      // Skip messages from self
      if (msg.key.fromMe) continue;

      // Skip status broadcasts
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const message = this.parseMessage(profile, msg);
      if (message) {
        this.emitMessage(profile, message);
      }
    }
  }

  private parseMessage(profile: string, msg: WAMessage): AdapterInboundMessage | null {
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return null;

    const messageContent = msg.message;
    if (!messageContent) return null;

    // Determine sender
    let senderId = remoteJid;
    let senderName: string | undefined;

    if (isJidGroup(remoteJid)) {
      // Group message - get actual sender
      senderId = msg.key.participant || remoteJid;
      senderName = msg.pushName ?? undefined;
    } else {
      // Private message
      senderName = msg.pushName ?? undefined;
    }

    // Extract message content
    let content: string | undefined;
    let mediaType: AdapterInboundMessage['mediaType'];
    let mediaUrl: string | undefined;

    const contentType = getContentType(messageContent);

    switch (contentType) {
      case 'conversation':
        content = messageContent.conversation || undefined;
        break;
      case 'extendedTextMessage':
        content = messageContent.extendedTextMessage?.text || undefined;
        break;
      case 'imageMessage':
        mediaType = 'image';
        content = messageContent.imageMessage?.caption || undefined;
        // mediaUrl would need to be downloaded
        break;
      case 'videoMessage':
        mediaType = 'video';
        content = messageContent.videoMessage?.caption || undefined;
        break;
      case 'audioMessage':
        mediaType = 'audio';
        break;
      case 'documentMessage':
        mediaType = 'document';
        content = messageContent.documentMessage?.caption || undefined;
        break;
      default:
        // Unsupported message type
        return null;
    }

    return {
      conversationId: remoteJid,
      platformId: msg.key.id || `${Date.now()}`,
      senderId,
      senderName,
      senderHandle: jidToPhone(senderId),
      content,
      mediaType,
      mediaUrl,
      receivedAt: (msg.messageTimestamp as number) * 1000 || Date.now(),
      replyToId: messageContent.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
      metadata: {
        isGroup: isJidGroup(remoteJid),
        pushName: msg.pushName,
      },
    };
  }

  async disconnect(profile: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection) return;

    connection.shouldStop = true;

    if (connection.socket) {
      try {
        connection.socket.end(undefined);
      } catch {
        // Ignore disconnect errors
      }
    }

    this.profiles.delete(profile);
    this.connections.delete(profile);
    console.log(`[whatsapp:${profile}] Disconnected`);
  }

  async disconnectAll(): Promise<void> {
    const profiles = Array.from(this.profiles.keys());
    await Promise.all(profiles.map((p) => this.disconnect(p)));
  }

  async send(profile: string, message: AdapterOutboundMessage): Promise<SendResult> {
    const connection = this.profiles.get(profile);
    if (!connection || !connection.socket) {
      return { success: false, error: 'Profile not connected' };
    }

    try {
      // Determine recipient JID
      let jid = message.conversationId;
      if (!jid.includes('@')) {
        jid = phoneToJid(jid);
      }

      // Send the message - Baileys expects specific content types
      let result;
      if (message.content) {
        result = await connection.socket.sendMessage(jid, { text: message.content });
      } else {
        return { success: false, error: 'No content to send' };
      }

      return {
        success: true,
        platformId: result?.key?.id ?? undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Get the current QR code for pairing (if available)
   */
  getQRCode(profile: string): string | null {
    return this.profiles.get(profile)?.qrCode ?? null;
  }

  /**
   * Check if a profile needs pairing (no existing session)
   */
  needsPairing(profile: string): boolean {
    return !hasAuthState(profile);
  }

  /**
   * Get connection state with extra WhatsApp-specific info
   */
  getWhatsAppState(profile: string): AdapterConnectionState & {
    qrCode?: string;
    phoneNumber?: string;
    paired: boolean;
  } {
    const connection = this.profiles.get(profile);
    const baseState = this.getConnectionState(profile);

    return {
      ...baseState,
      qrCode: connection?.qrCode ?? undefined,
      phoneNumber: connection?.credentials.phoneNumber,
      paired: connection?.credentials.paired ?? false,
    };
  }
}
