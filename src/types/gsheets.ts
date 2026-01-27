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
