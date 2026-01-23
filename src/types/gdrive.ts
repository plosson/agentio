export type GDriveAccessLevel = 'readonly' | 'full';

export interface GDriveCredentials {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
  email: string;
  accessLevel: GDriveAccessLevel;
}

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  createdTime?: string;
  modifiedTime?: string;
  owners?: string[];
  parents?: string[];
  webViewLink?: string;
  webContentLink?: string;
  starred: boolean;
  trashed: boolean;
  shared: boolean;
  description?: string;
}

export interface GDriveListOptions {
  limit?: number;
  folderId?: string;
  query?: string;
  orderBy?: string;
  includeTrash?: boolean;
}

export interface GDriveSearchOptions {
  query: string;
  mimeType?: string;
  limit?: number;
  folderId?: string;
}

export interface GDriveFolderListOptions {
  limit?: number;
  parentId?: string;
  query?: string;
}

export interface GDriveDownloadOptions {
  fileIdOrUrl: string;
  outputPath: string;
  exportFormat?: GDriveExportFormat;
}

export interface GDriveDownloadResult {
  filename: string;
  path: string;
  size: number;
  mimeType: string;
}

// Export formats for Google Workspace files
export type GDriveExportFormat = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'txt' | 'html' | 'odt' | 'ods' | 'odp' | 'rtf' | 'tsv' | 'png' | 'jpeg' | 'svg';

export interface GDriveUploadOptions {
  filePath: string;
  name?: string;
  folderId?: string;
  mimeType?: string;
  convert?: boolean;
}

export interface GDriveUploadResult {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink?: string;
}
