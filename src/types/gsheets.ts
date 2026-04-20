export interface GSheetsCredentials {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
  email: string;
}

export interface GSheetsSpreadsheet {
  id: string;
  title: string;
  locale?: string;
  timeZone?: string;
  url: string;
  sheets: GSheetsSheet[];
}

export interface GSheetsSheet {
  id: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface GSheetsGetOptions {
  majorDimension?: 'ROWS' | 'COLUMNS';
  valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
}

export interface GSheetsGetResult {
  range: string;
  values: unknown[][];
}

export interface GSheetsUpdateOptions {
  valueInputOption?: 'RAW' | 'USER_ENTERED';
}

export interface GSheetsUpdateResult {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export interface GSheetsAppendOptions {
  valueInputOption?: 'RAW' | 'USER_ENTERED';
  insertDataOption?: 'OVERWRITE' | 'INSERT_ROWS';
}

export interface GSheetsAppendResult {
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export interface GSheetsClearResult {
  clearedRange: string;
}

export interface GSheetsCreateResult {
  id: string;
  title: string;
  url: string;
}

export interface GSheetsListOptions {
  limit?: number;
  query?: string;
}

export interface GSheetsListItem {
  id: string;
  title: string;
  owner?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink: string;
}

export type GSheetsHorizontalAlignment = 'LEFT' | 'CENTER' | 'RIGHT';
export type GSheetsVerticalAlignment = 'TOP' | 'MIDDLE' | 'BOTTOM';
export type GSheetsWrapStrategy = 'OVERFLOW_CELL' | 'CLIP' | 'WRAP';
export type GSheetsBorderStyle = 'all' | 'outer' | 'none';

export interface GSheetsFormatOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
  backgroundColor?: string;
  horizontalAlignment?: GSheetsHorizontalAlignment;
  verticalAlignment?: GSheetsVerticalAlignment;
  wrapStrategy?: GSheetsWrapStrategy;
  numberFormat?: string;
  border?: GSheetsBorderStyle;
  merge?: boolean;
  clearFormat?: boolean;
  raw?: Record<string, unknown>;
}

export interface GSheetsFormatResult {
  range: string;
  sheetTitle: string;
  appliedFields: string[];
  merged: boolean;
  cleared: boolean;
}

export type GSheetsResizeDimension = 'ROWS' | 'COLUMNS';

export interface GSheetsResizeOptions {
  pixelSize?: number;
  auto?: boolean;
}

export interface GSheetsResizeResult {
  range: string;
  sheetTitle: string;
  dimension: GSheetsResizeDimension;
  count: number;
  pixelSize?: number;
  auto: boolean;
}

export interface GSheetsBatchResult {
  replies: number;
  spreadsheetId: string;
}
