import { google } from 'googleapis';
import type { sheets_v4, drive_v3 } from 'googleapis';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { GOOGLE_OAUTH_CONFIG } from '../../config/credentials';
import type {
  GSheetsCredentials,
  GSheetsSpreadsheet,
  GSheetsSheet,
  GSheetsGetOptions,
  GSheetsGetResult,
  GSheetsUpdateOptions,
  GSheetsUpdateResult,
  GSheetsAppendOptions,
  GSheetsAppendResult,
  GSheetsClearResult,
  GSheetsCreateResult,
  GSheetsListOptions,
  GSheetsListItem,
} from '../../types/gsheets';

export class GSheetsClient implements ServiceClient {
  private credentials: GSheetsCredentials;
  private sheets: sheets_v4.Sheets;
  private drive: drive_v3.Drive;

  constructor(credentials: GSheetsCredentials) {
    this.credentials = credentials;
    const auth = this.createOAuthClient();
    this.sheets = google.sheets({ version: 'v4', auth });
    this.drive = google.drive({ version: 'v3', auth });
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.drive.files.list({
        pageSize: 1,
        q: "mimeType='application/vnd.google-apps.spreadsheet'",
      });
      return { valid: true, info: this.credentials.email };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async list(options: GSheetsListOptions = {}): Promise<GSheetsListItem[]> {
    const { limit = 10, query } = options;

    try {
      let q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
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
        webViewLink: file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}`,
      }));
    } catch (err) {
      this.throwApiError(err, 'list spreadsheets');
    }
  }

  async get(spreadsheetIdOrUrl: string, range: string, options: GSheetsGetOptions = {}): Promise<GSheetsGetResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);
    const cleanedRange = this.cleanRange(range);

    try {
      const call = this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: cleanedRange,
        majorDimension: options.majorDimension,
        valueRenderOption: options.valueRenderOption,
      });

      const response = await call;

      return {
        range: response.data.range || cleanedRange,
        values: (response.data.values as unknown[][]) || [],
      };
    } catch (err) {
      this.throwApiError(err, 'get values');
    }
  }

  async update(
    spreadsheetIdOrUrl: string,
    range: string,
    values: unknown[][],
    options: GSheetsUpdateOptions = {}
  ): Promise<GSheetsUpdateResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);
    const cleanedRange = this.cleanRange(range);
    const valueInputOption = options.valueInputOption || 'USER_ENTERED';

    try {
      const response = await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range: cleanedRange,
        valueInputOption,
        requestBody: {
          values,
        },
      });

      return {
        updatedRange: response.data.updatedRange || cleanedRange,
        updatedRows: response.data.updatedRows || 0,
        updatedColumns: response.data.updatedColumns || 0,
        updatedCells: response.data.updatedCells || 0,
      };
    } catch (err) {
      this.throwApiError(err, 'update values');
    }
  }

  async append(
    spreadsheetIdOrUrl: string,
    range: string,
    values: unknown[][],
    options: GSheetsAppendOptions = {}
  ): Promise<GSheetsAppendResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);
    const cleanedRange = this.cleanRange(range);
    const valueInputOption = options.valueInputOption || 'USER_ENTERED';

    try {
      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: cleanedRange,
        valueInputOption,
        insertDataOption: options.insertDataOption,
        requestBody: {
          values,
        },
      });

      const updates = response.data.updates;
      return {
        updatedRange: updates?.updatedRange || cleanedRange,
        updatedRows: updates?.updatedRows || 0,
        updatedColumns: updates?.updatedColumns || 0,
        updatedCells: updates?.updatedCells || 0,
      };
    } catch (err) {
      this.throwApiError(err, 'append values');
    }
  }

  async clear(spreadsheetIdOrUrl: string, range: string): Promise<GSheetsClearResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);
    const cleanedRange = this.cleanRange(range);

    try {
      const response = await this.sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: cleanedRange,
      });

      return {
        clearedRange: response.data.clearedRange || cleanedRange,
      };
    } catch (err) {
      this.throwApiError(err, 'clear values');
    }
  }

  async metadata(spreadsheetIdOrUrl: string): Promise<GSheetsSpreadsheet> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);

    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId,
      });

      const props = response.data.properties!;
      const sheets: GSheetsSheet[] = (response.data.sheets || []).map((sheet) => ({
        id: sheet.properties?.sheetId || 0,
        title: sheet.properties?.title || 'Untitled',
        rowCount: sheet.properties?.gridProperties?.rowCount || 0,
        columnCount: sheet.properties?.gridProperties?.columnCount || 0,
      }));

      return {
        id: response.data.spreadsheetId!,
        title: props.title || 'Untitled',
        locale: props.locale || undefined,
        timeZone: props.timeZone || undefined,
        url: response.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
        sheets,
      };
    } catch (err) {
      this.throwApiError(err, 'get metadata');
    }
  }

  async create(title: string, sheetNames?: string[]): Promise<GSheetsCreateResult> {
    try {
      const sheets: sheets_v4.Schema$Sheet[] | undefined = sheetNames?.map((name) => ({
        properties: {
          title: name.trim(),
        },
      }));

      const response = await this.sheets.spreadsheets.create({
        requestBody: {
          properties: {
            title,
          },
          sheets,
        },
      });

      return {
        id: response.data.spreadsheetId!,
        title: response.data.properties?.title || title,
        url: response.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${response.data.spreadsheetId}`,
      };
    } catch (err) {
      this.throwApiError(err, 'create spreadsheet');
    }
  }

  async copy(spreadsheetIdOrUrl: string, newTitle: string, parentFolderId?: string): Promise<GSheetsCreateResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);

    try {
      const response = await this.drive.files.copy({
        fileId: spreadsheetId,
        requestBody: {
          name: newTitle,
          parents: parentFolderId ? [parentFolderId] : undefined,
        },
        fields: 'id,name,webViewLink',
      });

      return {
        id: response.data.id!,
        title: response.data.name || newTitle,
        url: response.data.webViewLink || `https://docs.google.com/spreadsheets/d/${response.data.id}`,
      };
    } catch (err) {
      this.throwApiError(err, 'copy spreadsheet');
    }
  }

  async export(
    spreadsheetIdOrUrl: string,
    format: 'xlsx' | 'pdf' | 'csv' | 'ods' | 'tsv'
  ): Promise<{ data: Buffer; mimeType: string; extension: string }> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);

    const formatMap: Record<string, { mimeType: string; extension: string }> = {
      xlsx: {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: '.xlsx',
      },
      pdf: { mimeType: 'application/pdf', extension: '.pdf' },
      csv: { mimeType: 'text/csv', extension: '.csv' },
      ods: { mimeType: 'application/vnd.oasis.opendocument.spreadsheet', extension: '.ods' },
      tsv: { mimeType: 'text/tab-separated-values', extension: '.tsv' },
    };

    const formatInfo = formatMap[format];
    if (!formatInfo) {
      throw new CliError('INVALID_PARAMS', `Unknown export format: ${format}`, 'Use xlsx, pdf, csv, ods, or tsv');
    }

    try {
      const response = await this.drive.files.export(
        { fileId: spreadsheetId, mimeType: formatInfo.mimeType },
        { responseType: 'arraybuffer' }
      );

      return {
        data: Buffer.from(response.data as ArrayBuffer),
        mimeType: formatInfo.mimeType,
        extension: formatInfo.extension,
      };
    } catch (err) {
      this.throwApiError(err, 'export spreadsheet');
    }
  }

  private extractSpreadsheetId(idOrUrl: string): string {
    // Handle URLs like https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
    const urlMatch = idOrUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];

    // Handle other URL formats
    const idMatch = idOrUrl.match(/id=([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];

    // Assume it's already an ID
    return idOrUrl;
  }

  private cleanRange(range: string): string {
    // Some shells escape ! to \! (bash history expansion), which breaks API calls
    return range.replace(/\\!/g, '!');
  }

  private createOAuthClient() {
    const oauth2Client = new google.auth.OAuth2(
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
      if (code === 403) return 'Insufficient permissions to access this spreadsheet';
      if (code === 404) return 'Spreadsheet not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') return error.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
