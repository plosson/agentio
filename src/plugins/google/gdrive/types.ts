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

export interface GDriveCopyOptions {
  fileIdOrUrl: string;
  name?: string;
  folderId?: string;
}

export interface GDriveCopyResult {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  webViewLink?: string;
}

export type GDrivePermissionType = 'anyone' | 'user' | 'domain' | 'group';
export type GDrivePermissionRole = 'reader' | 'commenter' | 'writer' | 'owner';

export interface GDrivePermission {
  id: string;
  type: GDrivePermissionType;
  role: GDrivePermissionRole;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  allowFileDiscovery?: boolean;
}

export interface GDriveShareOptions {
  type: GDrivePermissionType;
  role?: GDrivePermissionRole;
  emailAddress?: string;
  domain?: string;
  sendNotificationEmail?: boolean;
  emailMessage?: string;
  allowFileDiscovery?: boolean;
}

export interface GDriveShareResult {
  permissionId: string;
  type: GDrivePermissionType;
  role: GDrivePermissionRole;
  emailAddress?: string;
  domain?: string;
}
