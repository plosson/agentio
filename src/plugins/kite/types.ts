export interface KiteCredentials {
  /** Normalised: scheme required, no trailing slash. */
  baseUrl: string;
  /** CLI bearer token from the device sign-in. */
  token: string;
  /** From /api/auth/me at setup time. */
  email: string;
  /** As returned at approval; informational, the server slides it on every use. */
  expiresAt: string;
}

export type KiteDocumentType = 'markdown' | 'html';

/** A document as the server returns it (the server calls it an artifact). */
export interface KiteRawDocument {
  id: string;
  slug: string;
  ownerId: string;
  isPublic: number | boolean;
  expiresAt: string | null;
  type: KiteDocumentType;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  content?: string;
}

export interface KiteRawSharingState {
  artifactId: string;
  isPublic: boolean;
  people: Array<{ id: string; email: string; pending: boolean; createdAt: string }>;
  domains: Array<{ id: string; domain: string; createdAt: string }>;
  expiresAt: string | null;
}

export interface KiteRawComment {
  id: string;
  author: { email: string; [key: string]: unknown } | null;
  body: string;
  createdAt: string;
  deleted?: boolean;
}

export interface KiteRawThread {
  id: string;
  status: 'open' | 'resolved';
  anchor: unknown;
  anchorLost: boolean;
  anchorDrifted: boolean;
  createdAt: string;
  resolvedAt: string | null;
  comments: KiteRawComment[];
}

export interface KiteMe {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

/** Where a new comment is anchored; absent for a comment on the whole document. */
export interface KiteCommentPosition {
  snippet?: string;
  headingId?: string;
  elementId?: string;
}

// --- What commands print with --json (§6.1): the plugin's own names, never the server's.

export interface KiteDocument {
  id: string;
  url: string;
  title: string;
  type: KiteDocumentType;
  version: number;
  updated: string;
}

export interface KiteSharing {
  id: string;
  isPublic: boolean;
  people: Array<{ email: string; pending: boolean }>;
  domains: string[];
  expiresAt: string | null;
}

export interface KiteThread {
  id: string;
  status: 'open' | 'resolved';
  anchor: unknown;
  anchorLost: boolean;
  anchorDrifted: boolean;
  comments: Array<{ author: string | null; body: string; createdAt: string }>;
}
