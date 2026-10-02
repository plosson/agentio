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
  /** Absent from servers that predate descriptions; null on documents published before they were required. */
  description?: string | null;
  summary?: string | null;
  /** The version the summary was written for. */
  summaryVersion?: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  content?: string;
  /** On the listing only: a workspace id, or "inbox". */
  workspaceId?: string;
}

export interface KiteRawWorkspace {
  id: string;
  name: string;
  description: string;
  count: number;
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
  /** One line on what it is; null when nobody has written one yet. */
  description: string | null;
  /** Up to ten lines on what it says; null when nobody has written one yet. */
  summary: string | null;
  /** The version the summary was written for; behind `version` when the content moved on without it. */
  summaryVersion: number | null;
  type: KiteDocumentType;
  version: number;
  updated: string;
}

export interface KiteWorkspace {
  id: string;
  name: string;
  /** What belongs in it. */
  description: string;
  /** How many documents in it you can see. */
  count: number;
}

/** What `organize` prints: every workspace, every document and where it sits, and what to do next. */
export interface KiteLibrary {
  workspaces: KiteWorkspace[];
  documents: Array<KiteDocument & { workspace: string }>;
  instructions: string;
}

export interface KiteSharing {
  id: string;
  isPublic: boolean;
  people: Array<{ email: string; pending: boolean }>;
  domains: string[];
  expiresAt: string | null;
}

export interface KiteReply {
  id: string;
  author: string | null;
  body: string;
  createdAt: string;
  mentions: unknown;
}

export interface KiteThread {
  id: string;
  status: 'open' | 'resolved';
  anchor: unknown;
  anchorLost: boolean;
  anchorDrifted: boolean;
  comments: Array<{ author: string | null; body: string; createdAt: string }>;
}
