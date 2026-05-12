import { Readable } from 'stream';
import { drive, type drive_v3 } from '@googleapis/drive';
import { docs, type docs_v1 } from '@googleapis/docs';
import { OAuth2Client } from 'google-auth-library';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import type { GDocsCredentials, GDocsDocument, GDocsListOptions, GDocsCreateResult, GDocsBatchResult } from '../../types/gdocs';

export class GDocsClient implements ServiceClient {
  private credentials: GDocsCredentials;
  private drive: drive_v3.Drive;
  private docsApi: docs_v1.Docs;

  constructor(credentials: GDocsCredentials) {
    this.credentials = credentials;
    const auth = this.createOAuthClient();
    this.drive = drive({ version: 'v3', auth: auth as any });
    this.docsApi = docs({ version: 'v1', auth: auth as any });
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.drive.files.list({ pageSize: 1, q: "mimeType='application/vnd.google-apps.document'" });
      return { valid: true, info: this.credentials.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async getAsMarkdown(docIdOrUrl: string): Promise<string> {
    const docId = this.extractDocId(docIdOrUrl);

    try {
      const response = await this.drive.files.export({
        fileId: docId,
        mimeType: 'text/markdown',
      });
      return response.data as string;
    } catch (err) {
      this.throwApiError(err, 'export document as markdown');
    }
  }

  async getAsDocx(docIdOrUrl: string): Promise<Buffer> {
    const docId = this.extractDocId(docIdOrUrl);

    try {
      const response = await this.drive.files.export(
        { fileId: docId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { responseType: 'arraybuffer' }
      );
      return Buffer.from(response.data as ArrayBuffer);
    } catch (err) {
      this.throwApiError(err, 'export document as docx');
    }
  }

  async create(title: string, markdown: string, folderId?: string): Promise<GDocsCreateResult> {
    try {
      const stream = Readable.from(Buffer.from(markdown, 'utf-8'));

      const response = await this.drive.files.create({
        requestBody: {
          name: title,
          mimeType: 'application/vnd.google-apps.document',
          parents: folderId ? [folderId] : undefined,
        },
        media: {
          mimeType: 'text/markdown',
          body: stream,
        },
        fields: 'id,name,webViewLink',
      });

      return {
        id: response.data.id!,
        title: response.data.name || title,
        webViewLink: response.data.webViewLink || `https://docs.google.com/document/d/${response.data.id}`,
      };
    } catch (err) {
      this.throwApiError(err, 'create document');
    }
  }

  async list(options: GDocsListOptions = {}): Promise<GDocsDocument[]> {
    const { limit = 10, query } = options;

    try {
      let q = "mimeType='application/vnd.google-apps.document' and trashed=false";
      if (query) {
        q += ` and ${query}`;
      }

      const response = await this.drive.files.list({
        pageSize: Math.min(limit, 100),
        q,
        fields: 'files(id,name,owners,createdTime,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
      });

      const files = response.data.files || [];
      return files.map((file) => ({
        id: file.id!,
        title: file.name || 'Untitled',
        owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || undefined,
        createdTime: file.createdTime || undefined,
        modifiedTime: file.modifiedTime || undefined,
        webViewLink: file.webViewLink || `https://docs.google.com/document/d/${file.id}`,
      }));
    } catch (err) {
      this.throwApiError(err, 'list documents');
    }
  }

  async batch(docIdOrUrl: string, requests: docs_v1.Schema$Request[]): Promise<GDocsBatchResult> {
    const documentId = this.extractDocId(docIdOrUrl);

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new CliError('INVALID_PARAMS', 'requests must be a non-empty array');
    }

    try {
      const response = await this.docsApi.documents.batchUpdate({
        documentId,
        requestBody: { requests },
      });

      return {
        replies: response.data.replies?.length ?? 0,
        documentId,
      };
    } catch (err) {
      this.throwApiError(err, 'execute batch update');
    }
  }

  private extractDocId(docIdOrUrl: string): string {
    // Matches both full URLs and docs.google.com URLs
    const urlMatch = docIdOrUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    return urlMatch ? urlMatch[1] : docIdOrUrl;
  }

  private createOAuthClient() {
    const oauth2Client = new OAuth2Client(
      GOOGLE_OAUTH_CONFIG.clientId,
      GOOGLE_OAUTH_CONFIG.clientSecret
    );

    oauth2Client.setCredentials({
      access_token: this.credentials.accessToken,
      refresh_token: this.credentials.refreshToken,
      expiry_date: this.credentials.expiryDate,
    });

    return oauth2Client;
  }

  private throwApiError(err: unknown, operation: string): never {
    const code = this.getErrorCode(err);
    const message = this.getErrorMessage(err);
    throw new CliError(code, `Failed to ${operation}: ${message}`);
  }

  private getErrorCode(err: unknown): ErrorCode {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (typeof code === 'number') return httpStatusToErrorCode(code);
    }
    return 'API_ERROR';
  }

  private getErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const error = err as Record<string, unknown>;
      const code = error.code || error.status;
      if (code === 401) return 'OAuth token expired or invalid';
      if (code === 403) return 'Insufficient permissions to access this document';
      if (code === 404) return 'Document not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') return error.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
