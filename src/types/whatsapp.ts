/**
 * WhatsApp credentials stored for a profile
 * Note: The actual auth state (keys, session) is stored in the gateway SQLite database
 */
export interface WhatsAppCredentials {
  // Profile identifier (phone number after pairing)
  phoneNumber?: string;
  // Display name of the WhatsApp account
  displayName?: string;
  // Whether this profile has been paired
  paired: boolean;
  // Timestamp of last successful connection
  lastConnected?: number;
}

/**
 * WhatsApp message types
 */
export type WhatsAppMessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact';

/**
 * WhatsApp contact info
 */
export interface WhatsAppContact {
  id: string;          // JID (e.g., "1234567890@s.whatsapp.net")
  name?: string;       // Push name
  notify?: string;     // Notify name
  verifiedName?: string; // Business verified name
  phone: string;       // Phone number extracted from JID
}

/**
 * WhatsApp chat info
 */
export interface WhatsAppChat {
  id: string;          // JID
  name?: string;       // Chat name (contact name or group name)
  isGroup: boolean;
  participantCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
}

/**
 * WhatsApp message
 */
export interface WhatsAppMessage {
  id: string;          // Message ID
  chatId: string;      // Chat JID
  senderId: string;    // Sender JID
  senderName?: string;
  timestamp: number;
  type: WhatsAppMessageType;
  content?: string;    // Text content
  caption?: string;    // Media caption
  mediaUrl?: string;   // URL for media
  quotedMessageId?: string;
  isFromMe: boolean;
}

/**
 * WhatsApp send options
 */
export interface WhatsAppSendOptions {
  quotedMessageId?: string;
}
