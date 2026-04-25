import makeWASocket, {
  DisconnectReason,
  WASocket,
  ConnectionState,
  WAMessage,
  MessageUpsertType,
  jidNormalizedUser,
  isJidGroup,
  getContentType,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import type { ServiceName } from '../../types/config';
import type {
  WhatsAppCredentials,
  WhatsAppGroup,
  WhatsAppGroupParticipant,
  WhatsAppParticipantAction,
} from '../../types/whatsapp';
import { CONFIG_DIR, loadConfig } from '../../config/config-manager';
import { BaseAdapter, type AdapterInboundMessage, type AdapterOutboundMessage, type SendResult, type ConnectionState as AdapterConnectionState } from './types';
import { useSQLiteAuthState, hasAuthState } from './whatsapp-auth';

// Media storage directory
const MEDIA_DIR = join(CONFIG_DIR, 'media');

// Ensure media directory exists
async function ensureMediaDir(): Promise<void> {
  if (!existsSync(MEDIA_DIR)) {
    await mkdir(MEDIA_DIR, { recursive: true });
  }
}

// Get file extension for media type
function getMediaExtension(mediaType: string, mimeType?: string): string {
  if (mimeType) {
    const ext = mimeType.split('/')[1]?.split(';')[0];
    if (ext) return `.${ext}`;
  }
  switch (mediaType) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'audio': return '.ogg';
    case 'document': return '.bin';
    default: return '.bin';
  }
}

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

  hasProfile(profile: string): boolean {
    return this.profiles.has(profile);
  }

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

        setTimeout(async () => {
          if (connection.shouldStop) return;
          // Bail if the profile was removed from config since we last tried.
          try {
            const cfg = await loadConfig();
            const exists = (cfg.profiles.whatsapp ?? []).some(
              (p) => (typeof p === 'string' ? p : p.name) === profile,
            );
            if (!exists) {
              console.log(`[whatsapp:${profile}] profile removed; stopping reconnect`);
              connection.shouldStop = true;
              this.setConnected(profile, false, 'Profile removed');
              return;
            }
          } catch {
            // If config can't be loaded, fall through and try anyway.
          }
          this.createSocket(profile);
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

      // Process message asynchronously (for media download)
      this.processMessage(profile, msg, connection.socket).catch((error) => {
        console.error(`[whatsapp:${profile}] Error processing message:`, error);
      });
    }
  }

  private async processMessage(profile: string, msg: WAMessage, socket: WASocket | null): Promise<void> {
    const message = await this.parseMessage(profile, msg, socket);
    if (message) {
      this.emitMessage(profile, message);
    }
  }

  private async parseMessage(profile: string, msg: WAMessage, socket: WASocket | null): Promise<AdapterInboundMessage | null> {
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
    let mediaPath: string | undefined;
    let mimeType: string | undefined;

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
        mimeType = messageContent.imageMessage?.mimetype || undefined;
        break;
      case 'videoMessage':
        mediaType = 'video';
        content = messageContent.videoMessage?.caption || undefined;
        mimeType = messageContent.videoMessage?.mimetype || undefined;
        break;
      case 'audioMessage':
        mediaType = 'audio';
        mimeType = messageContent.audioMessage?.mimetype || undefined;
        break;
      case 'documentMessage':
        mediaType = 'document';
        content = messageContent.documentMessage?.caption || undefined;
        mimeType = messageContent.documentMessage?.mimetype || undefined;
        break;
      default:
        // Unsupported message type
        return null;
    }

    // Download media if present
    if (mediaType && socket) {
      try {
        await ensureMediaDir();
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: { level: 'silent', child: () => ({ level: 'silent' }) } as any,
            reuploadRequest: socket.updateMediaMessage,
          }
        );

        if (buffer) {
          const extension = getMediaExtension(mediaType, mimeType);
          const filename = `${msg.key.id || Date.now()}${extension}`;
          mediaPath = join(MEDIA_DIR, filename);
          await Bun.write(mediaPath, buffer);
          console.log(`[whatsapp:${profile}] Downloaded media: ${filename}`);
        }
      } catch (error) {
        console.error(`[whatsapp:${profile}] Failed to download media:`, error);
        // Continue without media - message still gets stored
      }
    }

    return {
      conversationId: remoteJid,
      platformId: msg.key.id || `${Date.now()}`,
      senderId,
      senderName,
      senderHandle: jidToPhone(senderId),
      content,
      mediaType,
      mediaUrl: mediaPath, // Store local path as mediaUrl
      receivedAt: (msg.messageTimestamp as number) * 1000 || Date.now(),
      replyToId: messageContent.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
      metadata: {
        isGroup: isJidGroup(remoteJid),
        pushName: msg.pushName,
        mimeType,
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

      let result;

      // Handle media attachments
      if (message.mediaPath) {
        const file = Bun.file(message.mediaPath);
        if (!await file.exists()) {
          return { success: false, error: `File not found: ${message.mediaPath}` };
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const mimeType = file.type || 'application/octet-stream';
        const filename = message.mediaPath.split('/').pop() || 'file';

        switch (message.mediaType) {
          case 'image':
            result = await connection.socket.sendMessage(jid, {
              image: buffer,
              caption: message.content,
              mimetype: mimeType,
            });
            break;
          case 'video':
            result = await connection.socket.sendMessage(jid, {
              video: buffer,
              caption: message.content,
              mimetype: mimeType,
            });
            break;
          case 'audio':
            result = await connection.socket.sendMessage(jid, {
              audio: buffer,
              mimetype: mimeType,
              ptt: mimeType.includes('ogg'), // Voice note if ogg
            });
            break;
          case 'document':
          default:
            result = await connection.socket.sendMessage(jid, {
              document: buffer,
              fileName: filename,
              caption: message.content,
              mimetype: mimeType,
            });
            break;
        }
      } else if (message.content) {
        // Text-only message
        result = await connection.socket.sendMessage(jid, { text: message.content });
      } else {
        return { success: false, error: 'No content or media to send' };
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

  // ============ GROUP OPERATIONS ============

  /**
   * List all groups the user is participating in
   */
  async listGroups(profile: string): Promise<WhatsAppGroup[]> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    const groups = await connection.socket.groupFetchAllParticipating();
    const myJid = connection.socket.user?.id;

    return Object.values(groups).map((g) => {
      const myParticipant = g.participants?.find((p) => p.id === myJid);
      return {
        id: g.id,
        name: g.subject,
        description: g.desc ?? undefined,
        owner: g.owner ?? undefined,
        creation: g.creation,
        participantCount: g.participants?.length ?? 0,
        isAdmin: myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin',
        isSuperAdmin: myParticipant?.admin === 'superadmin',
        announce: g.announce ?? false,
        restrict: g.restrict ?? false,
      };
    });
  }

  /**
   * Get detailed group information
   */
  async getGroup(profile: string, groupId: string): Promise<WhatsAppGroup> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    const metadata = await connection.socket.groupMetadata(groupId);
    const myJid = connection.socket.user?.id;
    const myParticipant = metadata.participants?.find((p) => p.id === myJid);

    const participants: WhatsAppGroupParticipant[] = metadata.participants.map((p) => ({
      id: p.id,
      phone: jidToPhone(p.id),
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    }));

    return {
      id: metadata.id,
      name: metadata.subject,
      description: metadata.desc ?? undefined,
      owner: metadata.owner ?? undefined,
      creation: metadata.creation,
      participantCount: metadata.participants.length,
      participants,
      isAdmin: myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin',
      isSuperAdmin: myParticipant?.admin === 'superadmin',
      announce: metadata.announce ?? false,
      restrict: metadata.restrict ?? false,
    };
  }

  /**
   * Create a new group
   */
  async createGroup(profile: string, name: string, participants: string[], picturePath?: string): Promise<WhatsAppGroup> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    const jids = participants.map((p) => (p.includes('@') ? p : phoneToJid(p)));
    const result = await connection.socket.groupCreate(name, jids);

    // Set profile picture if provided
    if (picturePath) {
      await this.updateGroupPicture(profile, result.id, picturePath);
    }

    return this.getGroup(profile, result.id);
  }

  /**
   * Update group profile picture
   */
  async updateGroupPicture(profile: string, groupId: string, picturePath: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    const file = Bun.file(picturePath);
    if (!await file.exists()) {
      throw new Error(`File not found: ${picturePath}`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    await connection.socket.updateProfilePicture(groupId, buffer);
  }

  /**
   * Update group subject (name)
   */
  async updateGroupSubject(profile: string, groupId: string, subject: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    await connection.socket.groupUpdateSubject(groupId, subject);
  }

  /**
   * Update group description
   */
  async updateGroupDescription(profile: string, groupId: string, description: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    await connection.socket.groupUpdateDescription(groupId, description);
  }

  /**
   * Update group participants (add, remove, promote, demote)
   */
  async updateParticipants(
    profile: string,
    groupId: string,
    participants: string[],
    action: WhatsAppParticipantAction
  ): Promise<{ participant: string; status: string }[]> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    const jids = participants.map((p) => (p.includes('@') ? p : phoneToJid(p)));
    const results = await connection.socket.groupParticipantsUpdate(groupId, jids, action);

    return results.map((r) => ({
      participant: r.jid ?? 'unknown',
      status: r.status,
    }));
  }

  /**
   * Leave a group
   */
  async leaveGroup(profile: string, groupId: string): Promise<void> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    await connection.socket.groupLeave(groupId);
  }

  /**
   * Get group invite code
   */
  async getGroupInviteCode(profile: string, groupId: string): Promise<string> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    const code = await connection.socket.groupInviteCode(groupId);
    if (!code) {
      throw new Error('Failed to get invite code');
    }
    return code;
  }

  /**
   * Join a group via invite code
   */
  async joinGroupViaInvite(profile: string, inviteCode: string): Promise<string> {
    const connection = this.profiles.get(profile);
    if (!connection?.socket) {
      throw new Error('Profile not connected');
    }

    // Extract code from full URL if provided
    let code = inviteCode;
    if (inviteCode.includes('chat.whatsapp.com/')) {
      code = inviteCode.split('chat.whatsapp.com/').pop() || inviteCode;
    }

    const groupId = await connection.socket.groupAcceptInvite(code);
    if (!groupId) {
      throw new Error('Failed to join group');
    }
    return groupId;
  }

  /**
   * Resolve group name to JID or JID to name
   * Returns groupId if input looks like a JID, or searches for matching group name
   */
  async resolveGroup(profile: string, nameOrId: string): Promise<{ groupId: string | null; groupName: string | null }> {
    // If it looks like a group JID, get the name
    if (nameOrId.includes('@g.us')) {
      try {
        const group = await this.getGroup(profile, nameOrId);
        return { groupId: nameOrId, groupName: group.name };
      } catch {
        return { groupId: nameOrId, groupName: null };
      }
    }

    // Otherwise, search for group by name
    const groups = await this.listGroups(profile);
    const lowerName = nameOrId.toLowerCase();

    // Exact match first
    const exactMatch = groups.find((g) => g.name.toLowerCase() === lowerName);
    if (exactMatch) {
      return { groupId: exactMatch.id, groupName: exactMatch.name };
    }

    // Partial match
    const partialMatch = groups.find((g) => g.name.toLowerCase().includes(lowerName));
    if (partialMatch) {
      return { groupId: partialMatch.id, groupName: partialMatch.name };
    }

    return { groupId: null, groupName: null };
  }

  /**
   * Get cached group name for a JID (for display purposes)
   * This is a quick lookup that doesn't make API calls
   */
  async getGroupNameCached(profile: string, groupId: string): Promise<string | null> {
    try {
      const groups = await this.listGroups(profile);
      const group = groups.find((g) => g.id === groupId);
      return group?.name ?? null;
    } catch {
      return null;
    }
  }
}
