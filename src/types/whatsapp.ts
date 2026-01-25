export interface WhatsAppCredentials {
  // Path to the auth state directory (stores session keys, etc.)
  authStatePath: string;
  // Phone number associated with this account (for display)
  phoneNumber?: string;
  // Profile name from WhatsApp
  pushName?: string;
}

export interface WhatsAppContact {
  id: string; // JID format: number@s.whatsapp.net or group-id@g.us
  name?: string;
  pushName?: string;
  isGroup: boolean;
}

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  chatName?: string;
  fromMe: boolean;
  sender?: string;
  senderName?: string;
  timestamp: number;
  text?: string;
  caption?: string;
  hasMedia: boolean;
  mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  isGroup: boolean;
}

export interface WhatsAppSendOptions {
  // Phone number (will be normalized to JID) or group JID
  to: string;
  // Text message
  text?: string;
  // Path to media file to attach
  mediaPath?: string;
  // Caption for media
  caption?: string;
}

export interface WhatsAppSendResult {
  messageId: string;
  to: string;
  timestamp: number;
}

export interface WhatsAppChat {
  id: string;
  name?: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTime?: number;
  lastMessage?: string;
}

export interface WhatsAppListOptions {
  limit?: number;
  chatId?: string;
}
