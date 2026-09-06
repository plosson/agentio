export interface DropboxCredentials {
  /** App key from the Dropbox App Console. PKCE apps have no secret. */
  appKey: string;
  accessToken: string;
  /** Long-lived; Dropbox does not rotate it on refresh. */
  refreshToken: string;
  /** Unix ms. Access tokens live 4 hours. */
  expiryDate: number;
  accountId?: string;
  email?: string;
  name?: string;
}

export type DropboxEntryType = 'file' | 'folder' | 'deleted';

export interface DropboxEntry {
  type: DropboxEntryType;
  id: string;
  name: string;
  /** Path with the casing Dropbox stores, e.g. "/Documents/report.pdf". */
  path: string;
  size?: number;
  /** Server-side modification time (ISO 8601). Files only. */
  modified?: string;
  rev?: string;
  contentHash?: string;
}

export interface DropboxListOptions {
  path?: string;
  limit?: number;
  recursive?: boolean;
  foldersOnly?: boolean;
}

export interface DropboxSearchOptions {
  query: string;
  path?: string;
  limit?: number;
  filenameOnly?: boolean;
}

export interface DropboxUploadOptions {
  filePath: string;
  destination?: string;
  overwrite?: boolean;
}

export interface DropboxUploadResult {
  id: string;
  name: string;
  path: string;
  size: number;
  rev?: string;
}

export interface DropboxDownloadResult {
  /** Remote path that was downloaded. */
  path: string;
  outputPath: string;
  size: number;
  /** A folder is downloaded as a zip archive. */
  kind: 'file' | 'folder';
}

export interface DropboxAccount {
  accountId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  accountType: string;
  country?: string;
}

export interface DropboxLink {
  url: string;
  path: string;
  /** Temporary links expire after four hours; shared links do not expire. */
  kind: 'shared' | 'temporary';
}

/**
 * Dropbox addresses the account root as "" and everything else as an absolute
 * path with no trailing slash. Identifier forms (id:, rev:, ns:) are passed
 * through untouched.
 */
export function normalizeDropboxPath(input?: string): string {
  const trimmed = (input ?? '').trim();

  if (trimmed === '' || trimmed === '/') return '';
  if (/^(id|rev|ns):/.test(trimmed)) return trimmed;

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, '') : withLeadingSlash;
}
