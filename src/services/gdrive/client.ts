import { readFile, writeFile, stat } from 'fs/promises';
import { basename } from 'path';
import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import type {
  GDriveCredentials,
  GDriveFile,
  GDriveListOptions,
  GDriveSearchOptions,
  GDriveFolderListOptions,
  GDriveDownloadOptions,
  GDriveDownloadResult,
  GDriveUploadResult,
  GDriveUploadOptions,
  GDriveExportFormat,
} from '../../types/gdrive';

// Export MIME types for Google Workspace files
const EXPORT_MIME_TYPES: Record<string, Record<GDriveExportFormat, string | undefined>> = {
  'application/vnd.google-apps.document': {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text',
    txt: 'text/plain',
    html: 'text/html',
    rtf: 'application/rtf',
    xlsx: undefined, csv: undefined, pptx: undefined, ods: undefined, odp: undefined, tsv: undefined, png: undefined, jpeg: undefined, svg: undefined,
  },
  'application/vnd.google-apps.spreadsheet': {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    pdf: 'application/pdf',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    tsv: 'text/tab-separated-values',
    docx: undefined, odt: undefined, txt: undefined, html: undefined, rtf: undefined, pptx: undefined, odp: undefined, png: undefined, jpeg: undefined, svg: undefined,
  },
  'application/vnd.google-apps.presentation': {
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
    odp: 'application/vnd.oasis.opendocument.presentation',
    txt: 'text/plain',
    docx: undefined, odt: undefined, html: undefined, rtf: undefined, xlsx: undefined, csv: undefined, ods: undefined, tsv: undefined, png: undefined, jpeg: undefined, svg: undefined,
  },
  'application/vnd.google-apps.drawing': {
    pdf: 'application/pdf',
    png: 'image/png',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    docx: undefined, odt: undefined, txt: undefined, html: undefined, rtf: undefined, xlsx: undefined, csv: undefined, pptx: undefined, ods: undefined, odp: undefined, tsv: undefined,
  },
};

// MIME types that trigger conversion to Google Workspace format
const CONVERTIBLE_MIME_TYPES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'application/vnd.google-apps.document',
  'application/msword': 'application/vnd.google-apps.document',
  'application/vnd.oasis.opendocument.text': 'application/vnd.google-apps.document',
  'text/plain': 'application/vnd.google-apps.document',
  'text/html': 'application/vnd.google-apps.document',
  'application/rtf': 'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'application/vnd.google-apps.spreadsheet',
  'application/vnd.ms-excel': 'application/vnd.google-apps.spreadsheet',
  'application/vnd.oasis.opendocument.spreadsheet': 'application/vnd.google-apps.spreadsheet',
  'text/csv': 'application/vnd.google-apps.spreadsheet',
  'text/tab-separated-values': 'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'application/vnd.google-apps.presentation',
  'application/vnd.ms-powerpoint': 'application/vnd.google-apps.presentation',
  'application/vnd.oasis.opendocument.presentation': 'application/vnd.google-apps.presentation',
};

// File extension to MIME type mapping for conversion
const EXT_TO_MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

export class GDriveClient implements ServiceClient {
  private credentials: GDriveCredentials;
  private drive: drive_v3.Drive;

  constructor(credentials: GDriveCredentials) {
    this.credentials = credentials;
    const auth = this.createOAuthClient();
    this.drive = drive({ version: 'v3', auth: auth as any });
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.drive.files.list({ pageSize: 1 });
      return { valid: true, info: this.credentials.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async list(options: GDriveListOptions = {}): Promise<GDriveFile[]> {
    const { limit = 20, folderId, query, orderBy = 'modifiedTime desc', includeTrash = false } = options;

    try {
      const queryParts: string[] = [];

      if (!includeTrash) {
        queryParts.push('trashed = false');
      }

      if (folderId) {
        queryParts.push(`'${folderId}' in parents`);
      }

      if (query) {
        queryParts.push(query);
      }

      const q = queryParts.join(' and ') || undefined;
      const allFiles: GDriveFile[] = [];
      let pageToken: string | undefined;

      // Paginate through results until we have enough or no more pages
      do {
        const response = await this.drive.files.list({
          pageSize: Math.min(limit - allFiles.length, 100),
          pageToken,
          q,
          fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,owners,parents,webViewLink,webContentLink,starred,trashed,shared,description)',
          orderBy,
        });

        const files = (response.data.files || []).map(this.parseFile);
        allFiles.push(...files);
        pageToken = response.data.nextPageToken || undefined;
      } while (pageToken && allFiles.length < limit);

      return allFiles.slice(0, limit);
    } catch (err) {
      this.throwApiError(err, 'list files');
    }
  }

  async listFolders(options: GDriveFolderListOptions = {}): Promise<GDriveFile[]> {
    const { limit = 20, parentId, query } = options;

    const queryParts: string[] = [
      "mimeType = 'application/vnd.google-apps.folder'",
      'trashed = false',
    ];

    if (parentId) {
      queryParts.push(`'${parentId}' in parents`);
    }

    if (query) {
      queryParts.push(query);
    }

    return this.list({
      limit,
      query: queryParts.join(' and '),
      orderBy: 'name',
    });
  }

  async get(fileIdOrUrl: string): Promise<GDriveFile> {
    const fileId = this.extractFileId(fileIdOrUrl);

    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'id,name,mimeType,size,createdTime,modifiedTime,owners,parents,webViewLink,webContentLink,starred,trashed,shared,description',
      });

      return this.parseFile(response.data);
    } catch (err) {
      this.throwApiError(err, 'get file');
    }
  }

  async search(options: GDriveSearchOptions): Promise<GDriveFile[]> {
    const { query, mimeType, limit = 20, folderId } = options;

    const queryParts: string[] = [
      'trashed = false',
      `fullText contains '${query.replace(/'/g, "\\'")}'`,
    ];

    if (mimeType) {
      queryParts.push(`mimeType = '${mimeType}'`);
    }

    if (folderId) {
      queryParts.push(`'${folderId}' in parents`);
    }

    return this.list({
      limit,
      query: queryParts.join(' and '),
    });
  }

  async download(options: GDriveDownloadOptions): Promise<GDriveDownloadResult> {
    const { fileIdOrUrl, outputPath, exportFormat } = options;
    const fileId = this.extractFileId(fileIdOrUrl);

    try {
      const file = await this.get(fileId);
      const isWorkspaceFile = file.mimeType.startsWith('application/vnd.google-apps.');

      // Handle Google Workspace files
      if (isWorkspaceFile) {
        if (!exportFormat) {
          const supportedFormats = this.getSupportedExportFormats(file.mimeType);
          throw new CliError(
            'INVALID_PARAMS',
            `Cannot download Google ${this.getWorkspaceTypeName(file.mimeType)} directly`,
            `Use --export with one of: ${supportedFormats.join(', ')}`
          );
        }

        const exportMimeType = this.getExportMimeType(file.mimeType, exportFormat);
        if (!exportMimeType) {
          const supportedFormats = this.getSupportedExportFormats(file.mimeType);
          throw new CliError(
            'INVALID_PARAMS',
            `Cannot export Google ${this.getWorkspaceTypeName(file.mimeType)} to ${exportFormat}`,
            `Supported formats: ${supportedFormats.join(', ')}`
          );
        }

        const response = await this.drive.files.export(
          { fileId, mimeType: exportMimeType },
          { responseType: 'arraybuffer' }
        );

        const buffer = Buffer.from(response.data as ArrayBuffer);
        await writeFile(outputPath, buffer);

        return {
          filename: file.name,
          path: outputPath,
          size: buffer.length,
          mimeType: exportMimeType,
        };
      }

      // Handle regular files
      if (exportFormat) {
        throw new CliError(
          'INVALID_PARAMS',
          'Export format is only for Google Workspace files',
          'Remove --export flag for regular files'
        );
      }

      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );

      const buffer = Buffer.from(response.data as ArrayBuffer);
      await writeFile(outputPath, buffer);

      return {
        filename: file.name,
        path: outputPath,
        size: buffer.length,
        mimeType: file.mimeType,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      this.throwApiError(err, 'download file');
    }
  }

  async upload(options: GDriveUploadOptions): Promise<GDriveUploadResult> {
    // Treat missing accessLevel as readonly for backward compatibility
    if (!this.credentials.accessLevel || this.credentials.accessLevel === 'readonly') {
      throw new CliError(
        'PERMISSION_DENIED',
        'This profile has read-only access',
        'Create a new profile with full access: agentio gdrive profile add --full'
      );
    }

    const { filePath, name, folderId, mimeType, convert } = options;

    try {
      const { extname } = await import('path');
      const fileStats = await stat(filePath);
      const content = await readFile(filePath);
      const fileName = name || basename(filePath);
      const ext = extname(filePath).toLowerCase();

      // Determine source MIME type
      const sourceMimeType = mimeType || EXT_TO_MIME[ext] || 'application/octet-stream';

      // Check if conversion is requested
      let targetMimeType: string | undefined;
      if (convert) {
        targetMimeType = CONVERTIBLE_MIME_TYPES[sourceMimeType];
        if (!targetMimeType) {
          throw new CliError(
            'INVALID_PARAMS',
            `Cannot convert ${ext || 'this file type'} to Google Workspace format`,
            'Supported: docx, doc, odt, txt, html, rtf, xlsx, xls, ods, csv, tsv, pptx, ppt, odp'
          );
        }
      }

      const fileMetadata: { name: string; parents?: string[]; mimeType?: string } = {
        name: convert ? fileName.replace(/\.[^.]+$/, '') : fileName, // Remove extension when converting
      };

      if (folderId) {
        fileMetadata.parents = [folderId];
      }

      if (targetMimeType) {
        fileMetadata.mimeType = targetMimeType;
      }

      const response = await this.drive.files.create({
        requestBody: fileMetadata,
        media: {
          mimeType: sourceMimeType,
          body: content,
        },
        fields: 'id,name,mimeType,size,webViewLink',
      });

      return {
        id: response.data.id!,
        name: response.data.name || fileName,
        mimeType: response.data.mimeType || sourceMimeType,
        size: fileStats.size,
        webViewLink: response.data.webViewLink || undefined,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      this.throwApiError(err, 'upload file');
    }
  }

  private extractFileId(fileIdOrUrl: string): string {
    const patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]+)/,
      /\/folders\/([a-zA-Z0-9_-]+)/,
      /id=([a-zA-Z0-9_-]+)/,
    ];

    for (const pattern of patterns) {
      const match = fileIdOrUrl.match(pattern);
      if (match) return match[1];
    }

    return fileIdOrUrl;
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

  private parseFile(file: drive_v3.Schema$File): GDriveFile {
    return {
      id: file.id!,
      name: file.name || 'Untitled',
      mimeType: file.mimeType || 'application/octet-stream',
      size: file.size ? parseInt(file.size, 10) : undefined,
      createdTime: file.createdTime || undefined,
      modifiedTime: file.modifiedTime || undefined,
      owners: file.owners?.map((o) => o.displayName || o.emailAddress || 'Unknown'),
      parents: file.parents || undefined,
      webViewLink: file.webViewLink || undefined,
      webContentLink: file.webContentLink || undefined,
      starred: file.starred || false,
      trashed: file.trashed || false,
      shared: file.shared || false,
      description: file.description || undefined,
    };
  }

  private getWorkspaceTypeName(mimeType: string): string {
    const types: Record<string, string> = {
      'application/vnd.google-apps.document': 'Doc',
      'application/vnd.google-apps.spreadsheet': 'Sheet',
      'application/vnd.google-apps.presentation': 'Slide',
      'application/vnd.google-apps.drawing': 'Drawing',
      'application/vnd.google-apps.form': 'Form',
    };
    return types[mimeType] || 'Workspace file';
  }

  private getExportMimeType(sourceMimeType: string, format: GDriveExportFormat): string | undefined {
    const formatMap = EXPORT_MIME_TYPES[sourceMimeType];
    return formatMap?.[format];
  }

  private getSupportedExportFormats(mimeType: string): string[] {
    const formatMap = EXPORT_MIME_TYPES[mimeType];
    if (!formatMap) return [];
    return Object.entries(formatMap)
      .filter(([, mime]) => mime !== undefined)
      .map(([format]) => format);
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
      if (code === 403) return 'Insufficient permissions to access this file';
      if (code === 404) return 'File not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') return error.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
