export interface GScriptCredentials {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
  email: string;
}

export type GScriptFileType = 'SERVER_JS' | 'JSON' | 'HTML';

export interface GScriptFile {
  name: string;          // bare name, no extension (API shape)
  type: GScriptFileType;
  source: string;
}

export interface GScriptProject {
  scriptId: string;
  title: string;
  parentId?: string;
  createTime?: string;
  updateTime?: string;
  creator?: string;
  lastModifyUser?: string;
  url: string;           // editor URL: https://script.google.com/d/<scriptId>/edit
}

export interface GScriptListItem {
  scriptId: string;
  title: string;
  parentId?: string;
  modifiedTime?: string;
}

export interface GScriptListOptions {
  parentId?: string;
  limit?: number;
}

export interface GScriptCreateOptions {
  title: string;
  parentId?: string;
}

export interface GScriptPullResult {
  rootDir: string;
  scriptId: string;
  files: { localPath: string; type: GScriptFileType }[];
}

export interface GScriptPushResult {
  scriptId: string;
  files: { name: string; type: GScriptFileType }[];
}
