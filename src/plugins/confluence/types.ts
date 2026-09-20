// Confluence OAuth credentials stored per profile
// Reuses the same Atlassian OAuth client as JIRA (see config/credentials.ts).
export interface ConfluenceCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  cloudId: string;
  siteUrl: string;
}

// Confluence Space
export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;       // 'global' | 'personal' | 'collaboration' | 'knowledge_base'
  status: string;     // 'current' | 'archived'
  homepageId?: string;
  description?: string;
}

// Confluence Page (summary, used for lists)
export interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  status: string;     // 'current' | 'draft' | 'archived' | 'trashed'
  parentId?: string;
  authorId?: string;
  createdAt: string;
  version: number;
  webUrl?: string;    // absolute URL when buildable
}

// Confluence Page with body content
export interface ConfluencePageDetail extends ConfluencePage {
  body?: string;          // plain text extracted from storage/ADF
  bodyFormat?: 'storage' | 'atlas_doc_format' | 'view';
}

// Confluence Comment
export interface ConfluenceComment {
  id: string;
  pageId: string;
  authorId?: string;
  body: string;
  createdAt: string;
  version: number;
}

// Search options (CQL)
export interface ConfluenceSearchOptions {
  cql?: string;
  spaceKey?: string;
  type?: 'page' | 'blogpost' | 'comment' | 'attachment';
  text?: string;
  limit?: number;
}

// Search result row
export interface ConfluenceSearchResult {
  id: string;
  type: string;
  title: string;
  spaceKey?: string;
  url?: string;
  excerpt?: string;
  lastModified?: string;
}

// List options
export interface ConfluencePageListOptions {
  spaceId?: string;
  spaceKey?: string;
  limit?: number;
  parentId?: string;
}

export interface ConfluenceSpaceListOptions {
  limit?: number;
  type?: string;
}

// Result types
export interface ConfluencePageCreateResult {
  id: string;
  title: string;
  spaceId: string;
  webUrl?: string;
}

export interface ConfluencePageUpdateResult {
  id: string;
  title: string;
  version: number;
}

export interface ConfluenceCommentResult {
  id: string;
  pageId: string;
}
