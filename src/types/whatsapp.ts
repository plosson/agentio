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

/**
 * WhatsApp group information
 */
export interface WhatsAppGroup {
  id: string;              // Group JID (e.g., "120363xxx@g.us")
  name: string;            // Group subject/name
  description?: string;
  owner?: string;          // Owner JID
  creation?: number;       // Creation timestamp
  participantCount: number;
  participants?: WhatsAppGroupParticipant[];
  isAdmin: boolean;        // Whether current user is admin
  isSuperAdmin: boolean;   // Whether current user is super admin (creator)
  announce: boolean;       // Only admins can send messages
  restrict: boolean;       // Only admins can modify group info
  inviteCode?: string;
}

/**
 * WhatsApp group participant
 */
export interface WhatsAppGroupParticipant {
  id: string;              // Participant JID
  name?: string;           // Push name
  phone: string;           // Phone number
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/**
 * Options for creating a group
 */
export interface WhatsAppGroupCreateOptions {
  name: string;
  participants: string[];  // Phone numbers or JIDs
}

/**
 * Options for updating a group
 */
export interface WhatsAppGroupUpdateOptions {
  subject?: string;        // Group name
  description?: string;    // Group description
}

/**
 * Participant update action
 */
export type WhatsAppParticipantAction = 'add' | 'remove' | 'promote' | 'demote';
