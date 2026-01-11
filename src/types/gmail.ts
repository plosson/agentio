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
}

export interface GmailAttachment {
  filename: string;
  path: string;
  mimeType?: string;
}

export interface GmailAttachmentInfo {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailSendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  attachments?: GmailAttachment[];
}

export interface GmailReplyOptions {
  threadId: string;
  body: string;
  isHtml?: boolean;
}
