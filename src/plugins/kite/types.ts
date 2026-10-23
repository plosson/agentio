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

export type KiteDocumentType = 'markdown' | 'html' | 'canvas';

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

/** One version in GET /api/artifacts/:id/versions (Kite 1.3.0+). */
export interface KiteRawVersionSummary {
  version: number;
  createdAt: string;
  kind: 'published' | 'edited';
  type: KiteDocumentType;
  title: string;
  bytes: number;
  isCurrent: boolean;
  views: { views: number; ownerViews: number; otherViews: number };
}

export interface KiteRawVersions {
  artifactId: string;
  slug: string;
  url: string;
  currentVersion: number;
  retentionDays: number;
  versions: KiteRawVersionSummary[];
}

type KiteRawViewer = { kind: 'user'; email: string; displayName: string | null } | { kind: 'anonymous'; id: string };

/** GET /api/artifacts/:id/views (Kite 1.2.0+). */
export interface KiteRawDocumentViews {
  artifactId: string;
  version: number;
  latestVersionAt: string;
  retentionDays: number;
  totals: {
    views: number;
    uniqueViewers: number;
    anonymousViewers: number;
    ownerViews?: number;
    otherViews?: number;
    otherViewers?: number;
    agentFetches: number;
  };
  lastViewedAt: string | null;
  lastViewedVersion: number | null;
  openedSinceLatestVersion: boolean;
  viewers: Array<{
    viewer: KiteRawViewer;
    isOwner?: boolean;
    access: string;
    views: number;
    firstViewedAt: string;
    lastViewedAt: string;
    lastVersion: number;
  }>;
  recent: Array<{ viewedAt: string; version: number; viewer: KiteRawViewer; access: string; client: string }>;
}

/** GET /api/views (Kite 1.2.0+). */
export interface KiteRawViewsSummary {
  retentionDays: number;
  totals: { documents: number; opened: number; neverOpened: number; notOpenedSinceLatestVersion: number; views: number };
  artifacts: Array<{
    artifactId: string;
    title: string;
    url: string;
    version: number;
    views: number;
    uniqueViewers: number;
    ownerViews?: number;
    otherViews?: number;
    lastViewedAt: string | null;
    lastViewedVersion: number | null;
    openedSinceLatestVersion: boolean;
    agentFetches: number;
  }>;
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

/** One version of a document, without its content. */
export interface KiteVersion {
  version: number;
  /** published for version 1, edited for every later one. */
  kind: 'published' | 'edited';
  title: string;
  type: KiteDocumentType;
  bytes: number;
  created: string;
  /** The version readers see now. */
  current: boolean;
  /** Browser opens of this version in the retention window, yours included. */
  views: number;
  ownerViews: number;
  otherViews: number;
}

export interface KiteVersionList {
  id: string;
  url: string;
  currentVersion: number;
  /** How many days back the view counts go. */
  retentionDays: number;
  /** Newest first. */
  versions: KiteVersion[];
}

/** `get --version`: the document as it was at that version. */
export type KiteVersionDocument = KiteDocument & { content: string; currentVersion: number; current: boolean };

/** Who opened one document, as `views <id>` prints it. */
export interface KiteDocumentViews {
  id: string;
  version: number;
  retentionDays: number;
  /** Browser opens, yours included. Agent reads are counted apart, in agentReads. */
  views: number;
  ownerViews: number;
  otherViews: number;
  uniqueViewers: number;
  otherViewers: number;
  agentReads: number;
  lastViewedAt: string | null;
  lastViewedVersion: number | null;
  openedSinceLatestVersion: boolean;
  /** An email, "you", or "anonymous <id>" for a signed-out reader of a public link. */
  viewers: Array<{ who: string; you: boolean; access: string; views: number; lastViewedAt: string; lastVersion: number }>;
  /** Every open, newest first, agents' included. */
  recent: Array<{ at: string; version: number; who: string; access: string; client: string }>;
}

/** `views` with no id: every document you own. */
export interface KiteViewsSummary {
  retentionDays: number;
  totals: { documents: number; opened: number; neverOpened: number; notOpenedSinceLatestVersion: number; views: number };
  documents: Array<{
    id: string;
    title: string;
    url: string;
    version: number;
    views: number;
    ownerViews: number;
    otherViews: number;
    uniqueViewers: number;
    agentReads: number;
    lastViewedAt: string | null;
    openedSinceLatestVersion: boolean;
  }>;
}
