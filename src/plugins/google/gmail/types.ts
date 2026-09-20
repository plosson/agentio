export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  snippet: string;
  labels: string[];
  body?: string;
  attachments?: GmailAttachmentInfo[];
}

export interface GmailListOptions {
  limit?: number;
  query?: string;
  labels?: string[];
  metadata?: boolean;
}

export const GMAIL_LIST_HARD_CAP = 10_000;

export interface GmailAttachment {
  filename: string;
  path: string;
  mimeType?: string;
  contentId?: string;  // For inline images, referenced as cid:contentId in HTML
}

export interface GmailAttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messageListVisibility?: string;
  labelListVisibility?: string;
}

export interface GmailSendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  attachments?: GmailAttachment[];
  replyTo?: string; // Thread ID to reply to
}

export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: 'larger' | 'smaller';
}

export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

export interface GmailFilter {
  id: string;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}

export interface GmailFilterCreateOptions {
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}
