import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';
import { basename } from 'path';
import type { GmailMessage, GmailListOptions, GmailSendOptions, GmailAttachment, GmailAttachmentInfo, GmailLabel, GmailFilter, GmailFilterCriteria, GmailFilterAction, GmailFilterCreateOptions } from '../../types/gmail';
import { GMAIL_LIST_HARD_CAP } from '../../types/gmail';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import { chunk, retryWithBackoff } from '../../utils/batch';

export interface BatchModifyOptions {
  chunkSize?: number;
  maxRetries?: number;
  onProgress?: (info: BatchProgress) => void;
}

export interface BatchProgress {
  chunkIndex: number;
  totalChunks: number;
  ids: number;
  durationMs: number;
  status: 'ok' | 'failed';
  error?: string;
}

export interface BatchModifyResult {
  totalIds: number;
  ok: number;
  failed: { ids: string[]; reason: string }[];
  chunks: number;
}

// RFC 2047 encode a header value if it contains non-ASCII characters
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

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
    this.gmail = gmail({ version: 'v1', auth: auth as any });
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
    const cappedLimit = Math.min(Math.max(limit, 0), GMAIL_LIST_HARD_CAP);
    const includeMetadata = options.metadata ?? cappedLimit <= 100;

    let q = query || '';
    if (labels?.length) {
      q += ' ' + labels.map((l) => `label:${l}`).join(' ');
    }

    try {
      const ids: { id: string; threadId: string }[] = [];
      let totalEstimate = 0;
      let pageToken: string | undefined;

      while (ids.length < cappedLimit) {
        const remaining = cappedLimit - ids.length;
        const response = await this.gmail.users.messages.list({
          userId: 'me',
          maxResults: Math.min(remaining, 500),
          q: q.trim() || undefined,
          pageToken,
        });

        if (!totalEstimate) {
          totalEstimate = response.data.resultSizeEstimate || 0;
        }
        for (const m of response.data.messages || []) {
          if (m.id && m.threadId) {
            ids.push({ id: m.id, threadId: m.threadId });
            if (ids.length >= cappedLimit) break;
          }
        }
        pageToken = response.data.nextPageToken || undefined;
        if (!pageToken) break;
      }

      const messages: GmailMessage[] = [];
      if (includeMetadata) {
        for (const { id } of ids) {
          const msg = await this.gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
          });
          messages.push(this.parseMessage(msg.data));
        }
      } else {
        for (const { id, threadId } of ids) {
          messages.push({
            id,
            threadId,
            subject: '',
            from: '',
            to: [],
            cc: [],
            date: '',
            snippet: '',
            labels: [],
          });
        }
      }

      return {
        messages,
        total: totalEstimate || messages.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
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
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
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
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
    }
  }

  async search(query: string, limit: number = 10): Promise<{ messages: GmailMessage[]; total: number }> {
    return this.list({ query, limit });
  }

  private async resolveReplyContext(threadId: string): Promise<{
    to: string[];
    subject: string;
    extraHeaders: string[];
  }> {
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

    const to = [headers['reply-to'] || headers['from'] || ''];
    const subject = headers['subject']?.startsWith('Re:')
      ? headers['subject']
      : `Re: ${headers['subject'] || '(no subject)'}`;
    const messageId = headers['message-id'] || '';

    const extraHeaders: string[] = [];
    if (messageId) {
      extraHeaders.push(`In-Reply-To: ${messageId}`);
      extraHeaders.push(`References: ${messageId}`);
    }

    return { to, subject, extraHeaders };
  }

  private async buildEncodedMessage(options: GmailSendOptions): Promise<string> {
    const { cc, bcc, body, isHtml, attachments, replyTo } = options;
    const userEmail = await this.getUserEmail();

    let to = options.to;
    let subject = options.subject;
    let extraHeaders: string[] | undefined;

    if (replyTo) {
      const replyContext = await this.resolveReplyContext(replyTo);
      if (!to.length) to = replyContext.to;
      if (!subject) subject = replyContext.subject;
      extraHeaders = replyContext.extraHeaders;
    }

    let rawMessage: string;

    if (attachments && attachments.length > 0) {
      rawMessage = await this.buildMultipartMessage({
        from: userEmail,
        to,
        cc,
        bcc,
        subject,
        body,
        isHtml,
        attachments,
        extraHeaders,
      });
    } else {
      rawMessage = [
        `From: ${userEmail}`,
        `To: ${to.join(', ')}`,
        cc?.length ? `Cc: ${cc.join(', ')}` : null,
        bcc?.length ? `Bcc: ${bcc.join(', ')}` : null,
        `Subject: ${encodeHeaderValue(subject)}`,
        ...(extraHeaders || []),
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '',
        body,
      ].filter((line): line is string => line !== null).join('\r\n');
    }

    return Buffer.from(rawMessage).toString('base64url');
  }

  async send(options: GmailSendOptions): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const encodedMessage = await this.buildEncodedMessage(options);

    try {
      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          ...(options.replyTo ? { threadId: options.replyTo } : {}),
        },
      });

      return {
        id: response.data.id!,
        threadId: response.data.threadId!,
        labelIds: response.data.labelIds || ['SENT'],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to send email: ${message}`);
    }
  }

  async draft(options: GmailSendOptions): Promise<{ id: string; messageId: string }> {
    const encodedMessage = await this.buildEncodedMessage(options);

    try {
      const response = await this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedMessage,
            ...(options.replyTo ? { threadId: options.replyTo } : {}),
          },
        },
      });

      return {
        id: response.data.id!,
        messageId: response.data.message?.id || '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create draft: ${message}`);
    }
  }

  async updateDraft(draftId: string, options: GmailSendOptions): Promise<{ id: string; messageId: string }> {
    const encodedMessage = await this.buildEncodedMessage(options);

    try {
      const response = await this.gmail.users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: {
          message: {
            raw: encodedMessage,
            ...(options.replyTo ? { threadId: options.replyTo } : {}),
          },
        },
      });

      return {
        id: response.data.id!,
        messageId: response.data.message?.id || '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('404') || message.toLowerCase().includes('not found')) {
        throw new CliError('NOT_FOUND', `Draft not found: ${draftId}`, 'Check the draft ID (use the ID returned when the draft was created).');
      }
      throw new CliError('API_ERROR', `Failed to update draft: ${message}`);
    }
  }

  async deleteDraft(draftId: string): Promise<void> {
    try {
      await this.gmail.users.drafts.delete({
        userId: 'me',
        id: draftId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('404') || message.toLowerCase().includes('not found')) {
        throw new CliError('NOT_FOUND', `Draft not found: ${draftId}`, 'Check the draft ID (use the ID returned when the draft was created).');
      }
      throw new CliError('API_ERROR', `Failed to delete draft: ${message}`);
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
    extraHeaders?: string[];
  }): Promise<string> {
    const { from, to, cc, bcc, subject, body, isHtml, attachments, extraHeaders } = options;

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
    lines.push(`Subject: ${encodeHeaderValue(subject)}`);
    if (extraHeaders) {
      for (const header of extraHeaders) {
        lines.push(header);
      }
    }
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
    } catch (error) {
      if (error instanceof CliError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to read attachment ${attachment.path}: ${message}`);
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
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to archive: ${message}`);
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
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to update message: ${message}`);
    }
  }

  private mapLabel(label: gmail_v1.Schema$Label): GmailLabel {
    return {
      id: label.id!,
      name: label.name!,
      type: label.type === 'system' ? 'system' : 'user',
      ...(label.messageListVisibility ? { messageListVisibility: label.messageListVisibility } : {}),
      ...(label.labelListVisibility ? { labelListVisibility: label.labelListVisibility } : {}),
    };
  }

  async listLabels(): Promise<GmailLabel[]> {
    try {
      const response = await this.gmail.users.labels.list({ userId: 'me' });
      const labels = (response.data.labels || []).map((l) => this.mapLabel(l));
      labels.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'system' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return labels;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
    }
  }

  async createLabel(name: string): Promise<GmailLabel> {
    try {
      const response = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          messageListVisibility: 'show',
          labelListVisibility: 'labelShow',
        },
      });
      return this.mapLabel(response.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create label: ${message}`);
    }
  }

  async deleteLabel(nameOrId: string): Promise<{ id: string; name: string }> {
    const label = await this.resolveLabel(nameOrId);
    if (label.type === 'system') {
      throw new CliError('INVALID_PARAMS', `Cannot delete system label: ${label.name}`);
    }
    try {
      await this.gmail.users.labels.delete({ userId: 'me', id: label.id });
      return { id: label.id, name: label.name };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to delete label: ${message}`);
    }
  }

  async renameLabel(oldNameOrId: string, newName: string): Promise<GmailLabel> {
    const label = await this.resolveLabel(oldNameOrId);
    if (label.type === 'system') {
      throw new CliError('INVALID_PARAMS', `Cannot rename system label: ${label.name}`);
    }
    try {
      const response = await this.gmail.users.labels.patch({
        userId: 'me',
        id: label.id,
        requestBody: { name: newName },
      });
      return this.mapLabel(response.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to rename label: ${message}`);
    }
  }

  async resolveLabelIds(namesOrIds: string[]): Promise<string[]> {
    if (namesOrIds.length === 0) return [];
    const labels = await this.listLabels();
    const byId = new Map(labels.map((l) => [l.id, l]));
    const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l]));
    return namesOrIds.map((input) => {
      const direct = byId.get(input);
      if (direct) return direct.id;
      const named = byName.get(input.toLowerCase());
      if (named) return named.id;
      throw new CliError('NOT_FOUND', `Label not found: ${input}`);
    });
  }

  private async resolveLabel(nameOrId: string): Promise<GmailLabel> {
    const labels = await this.listLabels();
    const direct = labels.find((l) => l.id === nameOrId);
    if (direct) return direct;
    const named = labels.find((l) => l.name.toLowerCase() === nameOrId.toLowerCase());
    if (named) return named;
    throw new CliError('NOT_FOUND', `Label not found: ${nameOrId}`);
  }

  async modifyLabels(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[],
    isThread: boolean,
  ): Promise<void> {
    const requestBody = {
      ...(addLabelIds.length ? { addLabelIds } : {}),
      ...(removeLabelIds.length ? { removeLabelIds } : {}),
    };
    try {
      if (isThread) {
        await this.gmail.users.threads.modify({ userId: 'me', id, requestBody });
      } else {
        await this.gmail.users.messages.modify({ userId: 'me', id, requestBody });
      }
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `${isThread ? 'Thread' : 'Message'} not found: ${id}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to modify labels: ${message}`);
    }
  }

  async expandThreadsToMessages(
    threadIds: string[],
    options: { concurrency?: number; maxRetries?: number } = {},
  ): Promise<string[]> {
    const concurrency = Math.max(1, options.concurrency ?? 8);
    const maxRetries = options.maxRetries ?? 5;
    const messageIds: string[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= threadIds.length) return;
        const id = threadIds[idx];
        try {
          const response = await retryWithBackoff(
            () =>
              this.gmail.users.threads.get({
                userId: 'me',
                id,
                format: 'minimal',
              }),
            { maxRetries },
          );
          for (const m of response.data.messages || []) {
            if (m.id) messageIds.push(m.id);
          }
        } catch (error) {
          if (this.isNotFoundError(error)) continue;
          const message = error instanceof Error ? error.message : String(error);
          throw new CliError('API_ERROR', `Failed to expand thread ${id}: ${message}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, threadIds.length) }, worker));
    return messageIds;
  }

  async batchModify(
    ids: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
    options: BatchModifyOptions = {},
  ): Promise<BatchModifyResult> {
    const chunkSize = Math.min(Math.max(options.chunkSize ?? 1000, 1), 1000);
    const maxRetries = options.maxRetries ?? 5;

    if (ids.length === 0 || (addLabelIds.length === 0 && removeLabelIds.length === 0)) {
      return { totalIds: ids.length, ok: 0, failed: [], chunks: 0 };
    }

    const chunks = chunk(ids, chunkSize);
    let ok = 0;
    const failed: { ids: string[]; reason: string }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const batch = chunks[i];
      const started = Date.now();
      try {
        await retryWithBackoff(
          () =>
            this.gmail.users.messages.batchModify({
              userId: 'me',
              requestBody: {
                ids: batch,
                ...(addLabelIds.length ? { addLabelIds } : {}),
                ...(removeLabelIds.length ? { removeLabelIds } : {}),
              },
            }),
          { maxRetries },
        );
        ok += batch.length;
        options.onProgress?.({
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          ids: batch.length,
          durationMs: Date.now() - started,
          status: 'ok',
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ ids: batch, reason });
        options.onProgress?.({
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          ids: batch.length,
          durationMs: Date.now() - started,
          status: 'failed',
          error: reason,
        });
      }
    }

    return { totalIds: ids.length, ok, failed, chunks: chunks.length };
  }

  private mapFilter(filter: gmail_v1.Schema$Filter): GmailFilter {
    const rawCriteria = filter.criteria || {};
    const criteria: GmailFilterCriteria = {};
    if (rawCriteria.from) criteria.from = rawCriteria.from;
    if (rawCriteria.to) criteria.to = rawCriteria.to;
    if (rawCriteria.subject) criteria.subject = rawCriteria.subject;
    if (rawCriteria.query) criteria.query = rawCriteria.query;
    if (rawCriteria.negatedQuery) criteria.negatedQuery = rawCriteria.negatedQuery;
    if (rawCriteria.hasAttachment) criteria.hasAttachment = true;
    if (rawCriteria.excludeChats) criteria.excludeChats = true;
    if (typeof rawCriteria.size === 'number') criteria.size = rawCriteria.size;
    if (rawCriteria.sizeComparison === 'larger' || rawCriteria.sizeComparison === 'smaller') {
      criteria.sizeComparison = rawCriteria.sizeComparison;
    }

    const rawAction = filter.action || {};
    const action: GmailFilterAction = {};
    if (rawAction.addLabelIds?.length) action.addLabelIds = rawAction.addLabelIds;
    if (rawAction.removeLabelIds?.length) action.removeLabelIds = rawAction.removeLabelIds;
    if (rawAction.forward) action.forward = rawAction.forward;

    return { id: filter.id!, criteria, action };
  }

  async listFilters(): Promise<GmailFilter[]> {
    try {
      const response = await this.gmail.users.settings.filters.list({ userId: 'me' });
      return (response.data.filter || []).map((f) => this.mapFilter(f));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
    }
  }

  async getFilter(id: string): Promise<GmailFilter> {
    try {
      const response = await this.gmail.users.settings.filters.get({ userId: 'me', id });
      return this.mapFilter(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Filter not found: ${id}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
    }
  }

  async createFilter(options: GmailFilterCreateOptions): Promise<GmailFilter> {
    try {
      const response = await this.gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: options.criteria,
          action: options.action,
        },
      });
      return this.mapFilter(response.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create filter: ${message}`);
    }
  }

  async deleteFilter(id: string): Promise<void> {
    try {
      await this.gmail.users.settings.filters.delete({ userId: 'me', id });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Filter not found: ${id}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to delete filter: ${message}`);
    }
  }

  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code: unknown }).code === 404;
    }
    return false;
  }
}
