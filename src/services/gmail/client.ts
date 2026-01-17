import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { basename } from 'path';
import type { GmailMessage, GmailListOptions, GmailSendOptions, GmailReplyOptions, GmailAttachment, GmailAttachmentInfo } from '../../types/gmail';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';

// Common MIME types by extension
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export class GmailClient implements ServiceClient {
  private gmail: gmail_v1.Gmail;
  private userEmail: string | null = null;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async validate(): Promise<ValidationResult> {
    try {
      const email = await this.getUserEmail();
      return { valid: true, info: email };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Check if it's a refresh failure
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  private async getUserEmail(): Promise<string> {
    if (this.userEmail) return this.userEmail;

    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || 'me';
    return this.userEmail;
  }

  private parseHeaders(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const header of headers || []) {
      if (header.name && header.value) {
        result[header.name.toLowerCase()] = header.value;
      }
    }
    return result;
  }

  private extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): GmailAttachmentInfo[] {
    const attachments: GmailAttachmentInfo[] = [];

    const processpart = (part: gmail_v1.Schema$MessagePart): void => {
      if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
        attachments.push({
          id: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || 'application/octet-stream',
          size: part.body.size || 0,
        });
      }
      for (const child of part.parts || []) {
        processpart(child);
      }
    };

    if (payload) {
      processpart(payload);
    }

    return attachments;
  }

  private parseMessage(message: gmail_v1.Schema$Message, includeAttachments: boolean = false): GmailMessage {
    const headers = this.parseHeaders(message.payload?.headers);

    const parseAddresses = (value?: string): string[] => {
      if (!value) return [];
      return value.split(',').map((addr) => addr.trim());
    };

    const result: GmailMessage = {
      id: message.id!,
      threadId: message.threadId!,
      subject: headers['subject'] || '(no subject)',
      from: headers['from'] || '',
      to: parseAddresses(headers['to']),
      cc: parseAddresses(headers['cc']),
      date: headers['date'] || '',
      snippet: message.snippet || '',
      labels: message.labelIds || [],
    };

    if (includeAttachments) {
      const attachments = this.extractAttachments(message.payload);
      if (attachments.length > 0) {
        result.attachments = attachments;
      }
    }

    return result;
  }

  private getBody(payload: gmail_v1.Schema$MessagePart | undefined, preferHtml: boolean = false): string {
    if (!payload) return '';

    const findPart = (part: gmail_v1.Schema$MessagePart, mimeType: string): string | null => {
      if (part.mimeType === mimeType && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      for (const child of part.parts || []) {
        const result = findPart(child, mimeType);
        if (result) return result;
      }
      return null;
    };

    const targetMime = preferHtml ? 'text/html' : 'text/plain';
    const fallbackMime = preferHtml ? 'text/plain' : 'text/html';

    return findPart(payload, targetMime) || findPart(payload, fallbackMime) || '';
  }

  async list(options: GmailListOptions = {}): Promise<{ messages: GmailMessage[]; total: number }> {
    const { limit = 10, query, labels } = options;

    let q = query || '';
    if (labels?.length) {
      q += ' ' + labels.map((l) => `label:${l}`).join(' ');
    }

    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        maxResults: Math.min(limit, 100),
        q: q.trim() || undefined,
      });

      const messageIds = response.data.messages || [];
      const messages: GmailMessage[] = [];

      for (const { id } of messageIds) {
        if (!id) continue;
        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });
        messages.push(this.parseMessage(msg.data));
      }

      return {
        messages,
        total: response.data.resultSizeEstimate || messages.length,
      };
    } catch (error: any) {
      throw new CliError('API_ERROR', `Gmail API error: ${error.message}`);
    }
  }

  async get(messageId: string, format: 'text' | 'html' | 'raw' = 'text'): Promise<GmailMessage & { body: string }> {
    try {
      const response = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: format === 'raw' ? 'raw' : 'full',
      });

      const message = this.parseMessage(response.data, true);
      let body: string;

      if (format === 'raw') {
        body = response.data.raw ? Buffer.from(response.data.raw, 'base64').toString('utf-8') : '';
      } else {
        body = this.getBody(response.data.payload, format === 'html');
      }

      return { ...message, body };
    } catch (error: any) {
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Gmail API error: ${error.message}`);
    }
  }

  async getAllAttachments(messageId: string): Promise<Array<{ data: Buffer; attachment: GmailAttachmentInfo }>> {
    try {
      const message = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const attachments = this.extractAttachments(message.data.payload);

      if (attachments.length === 0) {
        return [];
      }

      const results: Array<{ data: Buffer; attachment: GmailAttachmentInfo }> = [];

      for (const attachment of attachments) {
        const response = await this.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachment.id,
        });

        if (response.data.data) {
          results.push({
            data: Buffer.from(response.data.data, 'base64'),
            attachment,
          });
        }
      }

      return results;
    } catch (error: any) {
      if (error instanceof CliError) throw error;
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Gmail API error: ${error.message}`);
    }
  }

  async search(query: string, limit: number = 10): Promise<{ messages: GmailMessage[]; total: number }> {
    return this.list({ query, limit });
  }

  async send(options: GmailSendOptions): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const { to, cc, bcc, subject, body, isHtml, attachments } = options;
    const userEmail = await this.getUserEmail();

    let rawMessage: string;

    if (attachments && attachments.length > 0) {
      // Build multipart MIME message with attachments
      rawMessage = await this.buildMultipartMessage({
        from: userEmail,
        to,
        cc,
        bcc,
        subject,
        body,
        isHtml,
        attachments,
      });
    } else {
      // Simple message without attachments
      rawMessage = [
        `From: ${userEmail}`,
        `To: ${to.join(', ')}`,
        cc?.length ? `Cc: ${cc.join(', ')}` : null,
        bcc?.length ? `Bcc: ${bcc.join(', ')}` : null,
        `Subject: ${subject}`,
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '',
        body,
      ].filter((line): line is string => line !== null).join('\r\n');
    }

    const encodedMessage = Buffer.from(rawMessage).toString('base64url');

    try {
      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage },
      });

      return {
        id: response.data.id!,
        threadId: response.data.threadId!,
        labelIds: response.data.labelIds || ['SENT'],
      };
    } catch (error: any) {
      throw new CliError('API_ERROR', `Failed to send email: ${error.message}`);
    }
  }

  private async buildMultipartMessage(options: {
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    isHtml?: boolean;
    attachments: GmailAttachment[];
  }): Promise<string> {
    const { from, to, cc, bcc, subject, body, isHtml, attachments } = options;

    // Separate inline and regular attachments
    const inlineAttachments = attachments.filter(a => a.contentId);
    const regularAttachments = attachments.filter(a => !a.contentId);

    const hasInline = inlineAttachments.length > 0;
    const hasRegular = regularAttachments.length > 0;

    // Generate boundaries
    const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const relatedBoundary = `----=_Related_${Date.now()}_${Math.random().toString(36).substring(2)}`;

    const lines: string[] = [];

    // Email headers
    lines.push(`From: ${from}`);
    lines.push(`To: ${to.join(', ')}`);
    if (cc?.length) lines.push(`Cc: ${cc.join(', ')}`);
    if (bcc?.length) lines.push(`Bcc: ${bcc.join(', ')}`);
    lines.push(`Subject: ${subject}`);
    lines.push('MIME-Version: 1.0');

    if (hasRegular && hasInline) {
      // Both: multipart/mixed containing multipart/related + regular attachments
      lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
      lines.push('');
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
      lines.push('');

      // HTML body
      lines.push(`--${relatedBoundary}`);
      lines.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`);
      lines.push('');
      lines.push(body);

      // Inline images
      for (const attachment of inlineAttachments) {
        const encoded = await this.encodeAttachment(attachment);
        lines.push(`--${relatedBoundary}`);
        lines.push(`Content-Type: ${encoded.mimeType}; name="${encoded.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push(`Content-ID: <${attachment.contentId}>`);
        lines.push(`Content-Disposition: inline; filename="${encoded.filename}"`);
        lines.push('');
        lines.push(encoded.base64);
      }
      lines.push(`--${relatedBoundary}--`);

      // Regular attachments
      for (const attachment of regularAttachments) {
        const encoded = await this.encodeAttachment(attachment);
        lines.push(`--${mixedBoundary}`);
        lines.push(`Content-Type: ${encoded.mimeType}; name="${encoded.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push(`Content-Disposition: attachment; filename="${encoded.filename}"`);
        lines.push('');
        lines.push(encoded.base64);
      }
      lines.push(`--${mixedBoundary}--`);

    } else if (hasInline) {
      // Only inline: multipart/related
      lines.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
      lines.push('');

      // HTML body
      lines.push(`--${relatedBoundary}`);
      lines.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`);
      lines.push('');
      lines.push(body);

      // Inline images
      for (const attachment of inlineAttachments) {
        const encoded = await this.encodeAttachment(attachment);
        lines.push(`--${relatedBoundary}`);
        lines.push(`Content-Type: ${encoded.mimeType}; name="${encoded.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push(`Content-ID: <${attachment.contentId}>`);
        lines.push(`Content-Disposition: inline; filename="${encoded.filename}"`);
        lines.push('');
        lines.push(encoded.base64);
      }
      lines.push(`--${relatedBoundary}--`);

    } else {
      // Only regular: multipart/mixed (original behavior)
      lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
      lines.push('');
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`);
      lines.push('');
      lines.push(body);

      for (const attachment of regularAttachments) {
        const encoded = await this.encodeAttachment(attachment);
        lines.push(`--${mixedBoundary}`);
        lines.push(`Content-Type: ${encoded.mimeType}; name="${encoded.filename}"`);
        lines.push('Content-Transfer-Encoding: base64');
        lines.push(`Content-Disposition: attachment; filename="${encoded.filename}"`);
        lines.push('');
        lines.push(encoded.base64);
      }
      lines.push(`--${mixedBoundary}--`);
    }

    return lines.join('\r\n');
  }

  private async encodeAttachment(attachment: GmailAttachment): Promise<{
    filename: string;
    mimeType: string;
    base64: string;
  }> {
    try {
      const file = Bun.file(attachment.path);
      const exists = await file.exists();
      if (!exists) {
        throw new CliError('NOT_FOUND', `Attachment not found: ${attachment.path}`);
      }

      const content = await file.arrayBuffer();
      const filename = attachment.filename || basename(attachment.path);
      const mimeType = attachment.mimeType || getMimeType(filename);

      return {
        filename,
        mimeType,
        base64: Buffer.from(content).toString('base64'),
      };
    } catch (error: any) {
      if (error instanceof CliError) throw error;
      throw new CliError('API_ERROR', `Failed to read attachment ${attachment.path}: ${error.message}`);
    }
  }

  async reply(options: GmailReplyOptions): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const { threadId, body, isHtml } = options;

    // Get the thread to find the last message
    try {
      const thread = await this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
      });

      const messages = thread.data.messages || [];
      if (messages.length === 0) {
        throw new CliError('NOT_FOUND', `Thread not found: ${threadId}`);
      }

      const lastMessage = messages[messages.length - 1];
      const headers = this.parseHeaders(lastMessage.payload?.headers);

      const userEmail = await this.getUserEmail();
      const replyTo = headers['reply-to'] || headers['from'] || '';
      const subject = headers['subject']?.startsWith('Re:')
        ? headers['subject']
        : `Re: ${headers['subject'] || '(no subject)'}`;
      const messageId = headers['message-id'] || '';

      const rawHeaders = [
        `From: ${userEmail}`,
        `To: ${replyTo}`,
        `Subject: ${subject}`,
        messageId ? `In-Reply-To: ${messageId}` : '',
        messageId ? `References: ${messageId}` : '',
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '',
        body,
      ].filter(Boolean).join('\r\n');

      const encodedMessage = Buffer.from(rawHeaders).toString('base64url');

      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });

      return {
        id: response.data.id!,
        threadId: response.data.threadId!,
        labelIds: response.data.labelIds || ['SENT'],
      };
    } catch (error: any) {
      if (error instanceof CliError) throw error;
      throw new CliError('API_ERROR', `Failed to send reply: ${error.message}`);
    }
  }

  async archive(messageId: string): Promise<void> {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['INBOX'],
        },
      });
    } catch (error: any) {
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Failed to archive: ${error.message}`);
    }
  }

  async mark(messageId: string, read: boolean): Promise<void> {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: read
          ? { removeLabelIds: ['UNREAD'] }
          : { addLabelIds: ['UNREAD'] },
      });
    } catch (error: any) {
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Failed to update message: ${error.message}`);
    }
  }
}
