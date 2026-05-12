export interface GDocsCredentials {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
  email: string;
}

export interface GDocsDocument {
  id: string;
  title: string;
  owner?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink: string;
}

export interface GDocsListOptions {
  limit?: number;
  query?: string;
}

export interface GDocsCreateResult {
  id: string;
  title: string;
  webViewLink: string;
}

export interface GDocsBatchResult {
  documentId: string;
  replies: unknown[];
}
