import { sheets, type sheets_v4 } from '@googleapis/sheets';
import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
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
  GSheetsFormatOptions,
  GSheetsFormatResult,
  GSheetsBorderStyle,
  GSheetsResizeOptions,
  GSheetsResizeResult,
  GSheetsResizeDimension,
  GSheetsBatchResult,
} from '../../types/gsheets';

function parseHexColor(hex: string): { red: number; green: number; blue: number } {
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) {
    throw new CliError('INVALID_PARAMS', `Invalid hex color: ${hex}`, 'Use format #rrggbb (e.g., #ff0000)');
  }
  return {
    red: parseInt(cleaned.slice(0, 2), 16) / 255,
    green: parseInt(cleaned.slice(2, 4), 16) / 255,
    blue: parseInt(cleaned.slice(4, 6), 16) / 255,
  };
}

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseA1Range(range: string): { sheetTitle?: string; cells?: string } {
  const bangIdx = range.indexOf('!');
  if (bangIdx === -1) {
    if (/^[A-Z]+\d*(:[A-Z]+\d*)?$/i.test(range) || /^\d+:\d+$/.test(range)) {
      return { cells: range };
    }
    return { sheetTitle: range };
  }
  let sheetTitle = range.slice(0, bangIdx);
  if (sheetTitle.startsWith("'") && sheetTitle.endsWith("'")) {
    sheetTitle = sheetTitle.slice(1, -1).replace(/''/g, "'");
  }
  const cells = range.slice(bangIdx + 1);
  return { sheetTitle, cells: cells || undefined };
}

function parseCellRange(cells?: string): {
  startRow?: number;
  endRow?: number;
  startCol?: number;
  endCol?: number;
} {
  if (!cells) return {};
  const [startRef, endRef] = cells.split(':');
  const parseRef = (ref: string): { col?: number; row?: number } => {
    const m = ref.match(/^([A-Z]+)?(\d+)?$/i);
    if (!m || (!m[1] && !m[2])) {
      throw new CliError('INVALID_PARAMS', `Invalid cell reference: ${ref}`, 'Use A1 notation like A1, B2, or A:B');
    }
    return {
      col: m[1] ? colLettersToIndex(m[1]) : undefined,
      row: m[2] ? parseInt(m[2], 10) - 1 : undefined,
    };
  };
  const s = parseRef(startRef);
  const e = endRef ? parseRef(endRef) : s;
  return {
    startCol: s.col,
    endCol: e.col !== undefined ? e.col + 1 : undefined,
    startRow: s.row,
    endRow: e.row !== undefined ? e.row + 1 : undefined,
  };
}

function buildBorderRequest(
  range: sheets_v4.Schema$GridRange,
  style: GSheetsBorderStyle
): sheets_v4.Schema$Request {
  const border: sheets_v4.Schema$Border = { style: style === 'none' ? 'NONE' : 'SOLID' };
  const req: sheets_v4.Schema$UpdateBordersRequest = {
    range,
    top: border,
    bottom: border,
    left: border,
    right: border,
  };
  if (style === 'all') {
    req.innerHorizontal = border;
    req.innerVertical = border;
  }
  return { updateBorders: req };
}

export class GSheetsClient implements ServiceClient {
  private credentials: GSheetsCredentials;
  private sheets: sheets_v4.Sheets;
  private drive: drive_v3.Drive;

  constructor(credentials: GSheetsCredentials) {
    this.credentials = credentials;
    const auth = this.createOAuthClient();
    this.sheets = sheets({ version: 'v4', auth: auth as any });
    this.drive = drive({ version: 'v3', auth: auth as any });
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

  async format(
    spreadsheetIdOrUrl: string,
    range: string,
    options: GSheetsFormatOptions
  ): Promise<GSheetsFormatResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);
    const cleanedRange = this.cleanRange(range);

    try {
      const { gridRange, sheetTitle } = await this.resolveGridRange(spreadsheetId, cleanedRange);
      const requests: sheets_v4.Schema$Request[] = [];
      const appliedFields: string[] = [];

      if (options.clearFormat) {
        requests.push({
          repeatCell: {
            range: gridRange,
            cell: {},
            fields: 'userEnteredFormat',
          },
        });
      }

      const cellFormat: sheets_v4.Schema$CellFormat = {};
      const maskParts: string[] = [];

      if (options.backgroundColor !== undefined) {
        cellFormat.backgroundColor = parseHexColor(options.backgroundColor);
        maskParts.push('backgroundColor');
      }
      if (options.horizontalAlignment !== undefined) {
        cellFormat.horizontalAlignment = options.horizontalAlignment;
        maskParts.push('horizontalAlignment');
      }
      if (options.verticalAlignment !== undefined) {
        cellFormat.verticalAlignment = options.verticalAlignment;
        maskParts.push('verticalAlignment');
      }
      if (options.wrapStrategy !== undefined) {
        cellFormat.wrapStrategy = options.wrapStrategy;
        maskParts.push('wrapStrategy');
      }
      if (options.numberFormat !== undefined) {
        cellFormat.numberFormat = { type: 'NUMBER', pattern: options.numberFormat };
        maskParts.push('numberFormat');
      }

      const textFormat: sheets_v4.Schema$TextFormat = {};
      const textMask: string[] = [];
      if (options.bold !== undefined) {
        textFormat.bold = options.bold;
        textMask.push('bold');
      }
      if (options.italic !== undefined) {
        textFormat.italic = options.italic;
        textMask.push('italic');
      }
      if (options.underline !== undefined) {
        textFormat.underline = options.underline;
        textMask.push('underline');
      }
      if (options.fontSize !== undefined) {
        textFormat.fontSize = options.fontSize;
        textMask.push('fontSize');
      }
      if (options.fontFamily !== undefined) {
        textFormat.fontFamily = options.fontFamily;
        textMask.push('fontFamily');
      }
      if (options.textColor !== undefined) {
        textFormat.foregroundColor = parseHexColor(options.textColor);
        textMask.push('foregroundColor');
      }

      if (textMask.length > 0) {
        cellFormat.textFormat = textFormat;
        for (const part of textMask) {
          maskParts.push(`textFormat.${part}`);
        }
      }

      if (options.raw) {
        Object.assign(cellFormat, options.raw);
        for (const key of Object.keys(options.raw)) {
          if (!maskParts.some((p) => p === key || p.startsWith(`${key}.`))) {
            maskParts.push(key);
          }
        }
      }

      if (maskParts.length > 0) {
        requests.push({
          repeatCell: {
            range: gridRange,
            cell: { userEnteredFormat: cellFormat },
            fields: maskParts.map((p) => `userEnteredFormat.${p}`).join(','),
          },
        });
        appliedFields.push(...maskParts);
      }

      if (options.border !== undefined) {
        requests.push(buildBorderRequest(gridRange, options.border));
        appliedFields.push(`border:${options.border}`);
      }

      if (options.merge) {
        requests.push({
          mergeCells: { range: gridRange, mergeType: 'MERGE_ALL' },
        });
      }

      if (requests.length === 0) {
        throw new CliError('INVALID_PARAMS', 'No formatting options specified', 'Pass at least one format flag or --clear-format');
      }

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });

      return {
        range: cleanedRange,
        sheetTitle,
        appliedFields,
        merged: !!options.merge,
        cleared: !!options.clearFormat,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      this.throwApiError(err, 'format range');
    }
  }

  async resize(
    spreadsheetIdOrUrl: string,
    range: string,
    options: GSheetsResizeOptions
  ): Promise<GSheetsResizeResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);
    const cleanedRange = this.cleanRange(range);

    if (!options.auto && options.pixelSize === undefined) {
      throw new CliError('INVALID_PARAMS', 'Specify --size <pixels> or --auto');
    }
    if (options.auto && options.pixelSize !== undefined) {
      throw new CliError('INVALID_PARAMS', '--size and --auto are mutually exclusive');
    }

    try {
      const { dimensionRange, sheetTitle, dimension } = await this.resolveDimensionRange(
        spreadsheetId,
        cleanedRange
      );

      const request: sheets_v4.Schema$Request = options.auto
        ? { autoResizeDimensions: { dimensions: dimensionRange } }
        : {
            updateDimensionProperties: {
              range: dimensionRange,
              properties: { pixelSize: options.pixelSize },
              fields: 'pixelSize',
            },
          };

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [request] },
      });

      const count = (dimensionRange.endIndex ?? 0) - (dimensionRange.startIndex ?? 0);
      return {
        range: cleanedRange,
        sheetTitle,
        dimension,
        count,
        pixelSize: options.pixelSize,
        auto: !!options.auto,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      this.throwApiError(err, 'resize dimension');
    }
  }

  async batch(spreadsheetIdOrUrl: string, requests: sheets_v4.Schema$Request[]): Promise<GSheetsBatchResult> {
    const spreadsheetId = this.extractSpreadsheetId(spreadsheetIdOrUrl);

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new CliError('INVALID_PARAMS', 'requests must be a non-empty array');
    }

    try {
      const response = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });

      return {
        replies: response.data.replies?.length ?? 0,
        spreadsheetId,
      };
    } catch (err) {
      this.throwApiError(err, 'execute batch update');
    }
  }

  private async resolveDimensionRange(
    spreadsheetId: string,
    a1range: string
  ): Promise<{
    dimensionRange: sheets_v4.Schema$DimensionRange;
    sheetTitle: string;
    dimension: GSheetsResizeDimension;
  }> {
    const { sheetTitle: requestedTitle, cells } = parseA1Range(a1range);
    if (!cells) {
      throw new CliError('INVALID_PARAMS', `Resize range must reference columns or rows (e.g. Sheet1!A:C or Sheet1!1:10)`);
    }
    const response = await this.sheets.spreadsheets.get({ spreadsheetId });
    const sheets = response.data.sheets || [];
    const targetSheet = requestedTitle
      ? sheets.find((s) => s.properties?.title === requestedTitle)
      : sheets[0];
    if (!targetSheet?.properties) {
      throw new CliError('NOT_FOUND', `Sheet not found: ${requestedTitle || '(first sheet)'}`);
    }
    const sheetId = targetSheet.properties.sheetId ?? 0;
    const { startRow, endRow, startCol, endCol } = parseCellRange(cells);

    const hasCols = startCol !== undefined;
    const hasRows = startRow !== undefined;
    if (hasCols && hasRows) {
      throw new CliError(
        'INVALID_PARAMS',
        `Resize range must be columns-only (A:C) or rows-only (1:10), got ${cells}`
      );
    }
    if (!hasCols && !hasRows) {
      throw new CliError('INVALID_PARAMS', `Could not parse resize range: ${cells}`);
    }

    const dimensionRange: sheets_v4.Schema$DimensionRange = hasCols
      ? { sheetId, dimension: 'COLUMNS', startIndex: startCol, endIndex: endCol }
      : { sheetId, dimension: 'ROWS', startIndex: startRow, endIndex: endRow };

    return {
      dimensionRange,
      sheetTitle: targetSheet.properties.title || '',
      dimension: hasCols ? 'COLUMNS' : 'ROWS',
    };
  }

  private async resolveGridRange(
    spreadsheetId: string,
    a1range: string
  ): Promise<{ gridRange: sheets_v4.Schema$GridRange; sheetTitle: string }> {
    const { sheetTitle: requestedTitle, cells } = parseA1Range(a1range);
    const response = await this.sheets.spreadsheets.get({ spreadsheetId });
    const sheets = response.data.sheets || [];
    const targetSheet = requestedTitle
      ? sheets.find((s) => s.properties?.title === requestedTitle)
      : sheets[0];
    if (!targetSheet?.properties) {
      throw new CliError('NOT_FOUND', `Sheet not found: ${requestedTitle || '(first sheet)'}`);
    }
    const sheetId = targetSheet.properties.sheetId ?? 0;
    const { startRow, endRow, startCol, endCol } = parseCellRange(cells);
    const gridRange: sheets_v4.Schema$GridRange = { sheetId };
    if (startRow !== undefined) gridRange.startRowIndex = startRow;
    if (endRow !== undefined) gridRange.endRowIndex = endRow;
    if (startCol !== undefined) gridRange.startColumnIndex = startCol;
    if (endCol !== undefined) gridRange.endColumnIndex = endCol;
    return { gridRange, sheetTitle: targetSheet.properties.title || '' };
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
      if (code === 403) return 'Insufficient permissions to access this spreadsheet';
      if (code === 404) return 'Spreadsheet not found';
      if (code === 429) return 'Rate limit exceeded, please try again later';
      if (error.message && typeof error.message === 'string') return error.message;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
