# Confluence Integration Task Breakdown

This document outlines the implementation steps for adding Confluence Cloud support to agentio, following the project's service development guidelines.

---

## Phase 1: Foundation

### Task 1.1: Add Service Name to Config

**File**: `src/types/config.ts`

Add `confluence` to the `Config` interface and `ServiceName` type:

```typescript
export interface Config {
  profiles: {
    // ... existing services
    confluence?: string[];
  };
  defaults: {
    // ... existing services
    confluence?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira' | 'slack' | 'telegram' | 'confluence';
```

**Effort**: 5 minutes

---

### Task 1.2: Create Type Definitions

**File**: `src/types/confluence.ts`

```typescript
// Confluence OAuth credentials (similar to Jira pattern)
export interface ConfluenceCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  cloudId: string;
  siteUrl: string;
}

// Space
export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: 'global' | 'personal';
  status: string;
}

// Page
export interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  status: 'current' | 'trashed' | 'draft';
  createdAt: string;
  version: number;
  parentId?: string;
  body?: {
    storage?: string;
    view?: string;
  };
  _links?: {
    webui?: string;
  };
}

// List options
export interface ConfluencePageListOptions {
  spaceId?: string;
  spaceKey?: string;
  limit?: number;
  cursor?: string;
  status?: 'current' | 'trashed' | 'draft';
}

// Search options
export interface ConfluenceSearchOptions {
  query: string;  // CQL query
  limit?: number;
  cursor?: string;
}

// Create page options
export interface ConfluenceCreatePageOptions {
  spaceId: string;
  title: string;
  body: string;
  parentId?: string;
  bodyFormat?: 'storage' | 'atlas_doc_format';
}

// Update page options
export interface ConfluenceUpdatePageOptions {
  title?: string;
  body?: string;
  bodyFormat?: 'storage' | 'atlas_doc_format';
  versionMessage?: string;
}

// Result types
export interface ConfluenceCreateResult {
  id: string;
  title: string;
  webUrl: string;
}

export interface ConfluenceUpdateResult {
  id: string;
  title: string;
  version: number;
  webUrl: string;
}
```

**Effort**: 30 minutes

---

### Task 1.3: Add OAuth Credentials

**File**: `src/config/credentials.ts`

Add Confluence OAuth client configuration (requires registering app in Atlassian Developer Console first):

```typescript
export const CONFLUENCE_OAUTH_CONFIG = {
  clientId: 'YOUR_CONFLUENCE_CLIENT_ID',
  clientSecret: 'YOUR_CONFLUENCE_CLIENT_SECRET',
};
```

**Prerequisites**: Register OAuth 2.0 app at https://developer.atlassian.com/console/myapps/

**Scopes to request**:
- `read:page:confluence`
- `write:page:confluence`
- `read:space:confluence`
- `search:confluence`
- `read:me`
- `offline_access`

**Effort**: 30 minutes (including Developer Console setup)

---

## Phase 2: OAuth Implementation

### Task 2.1: Extend OAuth Flow for Atlassian

**File**: `src/auth/oauth.ts` (modify existing)

The Atlassian OAuth flow differs from Google:
1. Authorization URL: `https://auth.atlassian.com/authorize`
2. Token URL: `https://auth.atlassian.com/oauth/token`
3. API requests go to: `https://api.atlassian.com/ex/confluence/{cloudId}`
4. Need to fetch accessible resources to get `cloudId`

Options:
- **Option A**: Add Atlassian-specific flow in existing `oauth.ts`
- **Option B**: Create `src/auth/atlassian-oauth.ts` (cleaner separation)

**Recommended**: Option B, since Jira already exists and can share the Atlassian OAuth logic.

```typescript
// src/auth/atlassian-oauth.ts

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export async function performAtlassianOAuthFlow(
  service: 'jira' | 'confluence',
  scopes: string[]
): Promise<AtlassianOAuthTokens>
```

**Note**: Check if Jira already has this - if so, refactor to share.

**Effort**: 2-3 hours

---

### Task 2.2: Site Selection Flow

After OAuth, user may have access to multiple Confluence sites. Need interactive selection:

```typescript
async function selectConfluenceSite(accessToken: string): Promise<{ cloudId: string; siteUrl: string }> {
  const resources = await fetchAccessibleResources(accessToken);
  const confluenceSites = resources.filter(r => r.scopes.includes('confluence'));

  if (confluenceSites.length === 0) {
    throw new CliError('NO_SITES', 'No Confluence sites found');
  }

  if (confluenceSites.length === 1) {
    return confluenceSites[0];
  }

  // Interactive selection for multiple sites
  return promptSiteSelection(confluenceSites);
}
```

**Effort**: 1 hour

---

## Phase 3: API Client

### Task 3.1: Create Confluence Client

**File**: `src/services/confluence/client.ts`

```typescript
export class ConfluenceClient {
  private credentials: ConfluenceCredentials;
  private baseUrl: string;

  constructor(credentials: ConfluenceCredentials) {
    this.credentials = credentials;
    this.baseUrl = `https://api.atlassian.com/ex/confluence/${credentials.cloudId}/wiki/api/v2`;
  }

  // Spaces
  async listSpaces(options?: { limit?: number }): Promise<ConfluenceSpace[]>
  async getSpace(spaceId: string): Promise<ConfluenceSpace>

  // Pages
  async listPages(options?: ConfluencePageListOptions): Promise<ConfluencePage[]>
  async getPage(pageId: string, includeBody?: boolean): Promise<ConfluencePage>
  async createPage(options: ConfluenceCreatePageOptions): Promise<ConfluenceCreateResult>
  async updatePage(pageId: string, options: ConfluenceUpdatePageOptions): Promise<ConfluenceUpdateResult>
  async deletePage(pageId: string, purge?: boolean): Promise<void>

  // Search
  async search(options: ConfluenceSearchOptions): Promise<ConfluencePage[]>

  // Private helpers
  private async request<T>(method: string, path: string, body?: unknown): Promise<T>
  private handleRateLimit(response: Response): Promise<void>
  private parsePage(raw: unknown): ConfluencePage
}
```

**Key considerations**:
- Cursor-based pagination (different from offset-based)
- Rate limit handling with `Retry-After` header
- Storage format parsing for body content

**Effort**: 4-5 hours

---

### Task 3.2: Token Refresh Logic

**File**: `src/auth/token-manager.ts` (modify existing)

Add Atlassian token refresh support (if not already present for Jira):

```typescript
async function refreshAtlassianToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<AtlassianOAuthTokens>
```

**Effort**: 1 hour (if not already done for Jira)

---

## Phase 4: CLI Commands

### Task 4.1: Create Command Handler

**File**: `src/commands/confluence.ts`

```typescript
export function registerConfluenceCommands(program: Command): void {
  const confluence = program
    .command('confluence')
    .description('Confluence operations');

  // Space commands
  confluence
    .command('spaces')
    .description('List spaces')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Number of spaces', '20')
    .action(async (options) => { ... });

  // Page commands
  confluence
    .command('list')
    .description('List pages in a space')
    .option('--profile <name>', 'Profile name')
    .option('--space <key>', 'Space key (required)')
    .option('--limit <n>', 'Number of pages', '20')
    .action(async (options) => { ... });

  confluence
    .command('get')
    .description('Get page content')
    .argument('<page-id>', 'Page ID')
    .option('--profile <name>', 'Profile name')
    .option('--format <format>', 'Output format: storage|view', 'view')
    .action(async (pageId, options) => { ... });

  confluence
    .command('search')
    .description('Search pages')
    .option('--profile <name>', 'Profile name')
    .option('--query <cql>', 'CQL search query (required)')
    .option('--limit <n>', 'Number of results', '20')
    .action(async (options) => { ... });

  confluence
    .command('create')
    .description('Create a new page')
    .option('--profile <name>', 'Profile name')
    .option('--space <key>', 'Space key (required)')
    .option('--title <title>', 'Page title (required)')
    .option('--parent <id>', 'Parent page ID')
    .argument('[body]', 'Page body (or pipe via stdin)')
    .action(async (body, options) => { ... });

  confluence
    .command('update')
    .description('Update a page')
    .argument('<page-id>', 'Page ID')
    .option('--profile <name>', 'Profile name')
    .option('--title <title>', 'New title')
    .option('--message <msg>', 'Version message')
    .argument('[body]', 'New body (or pipe via stdin)')
    .action(async (pageId, body, options) => { ... });

  confluence
    .command('delete')
    .description('Delete a page (moves to trash)')
    .argument('<page-id>', 'Page ID')
    .option('--profile <name>', 'Profile name')
    .option('--purge', 'Permanently delete (only works for trashed pages)')
    .action(async (pageId, options) => { ... });

  // Profile subcommands
  const profile = confluence.command('profile').description('Manage Confluence profiles');

  profile.command('add')
    .option('--profile <name>', 'Profile name')
    .action(async (options) => { ... });

  profile.command('list')
    .action(async () => { ... });

  profile.command('remove')
    .option('--profile <name>', 'Profile name (required)')
    .action(async (options) => { ... });
}
```

**Effort**: 3-4 hours

---

### Task 4.2: Add Output Formatters

**File**: `src/utils/output.ts` (modify existing)

```typescript
export function printConfluenceSpaceList(spaces: ConfluenceSpace[]): void
export function printConfluencePageList(pages: ConfluencePage[]): void
export function printConfluencePage(page: ConfluencePage): void
export function printConfluenceCreateResult(result: ConfluenceCreateResult): void
export function printConfluenceUpdateResult(result: ConfluenceUpdateResult): void
```

**Effort**: 1 hour

---

### Task 4.3: Register Commands

**File**: `src/index.ts` (modify existing)

```typescript
import { registerConfluenceCommands } from './commands/confluence';

// In the registration section:
registerConfluenceCommands(program);
```

**Effort**: 5 minutes

---

## Phase 5: Testing and Polish

### Task 5.1: Manual Testing Checklist

- [ ] `confluence profile add` - OAuth flow works, site selection works
- [ ] `confluence profile list` - Shows profiles with site info
- [ ] `confluence profile remove` - Removes profile and credentials
- [ ] `confluence spaces` - Lists available spaces
- [ ] `confluence list --space <key>` - Lists pages in space
- [ ] `confluence get <id>` - Shows page content
- [ ] `confluence search --query "<cql>"` - Search works
- [ ] `confluence create --space <key> --title <title>` - Creates page
- [ ] `confluence update <id> --title <new>` - Updates page
- [ ] `confluence delete <id>` - Moves to trash
- [ ] Rate limit handling (trigger 429, verify retry)
- [ ] Token refresh (wait for expiry, verify auto-refresh)

**Effort**: 2-3 hours

---

### Task 5.2: Error Handling Review

Verify all error cases produce helpful `CliError` messages:
- No profile configured
- Invalid credentials / expired token
- Space not found
- Page not found
- Permission denied
- Rate limited
- Network errors

**Effort**: 1 hour

---

## Summary

| Phase | Tasks | Estimated Effort |
|-------|-------|------------------|
| Phase 1: Foundation | 1.1, 1.2, 1.3 | 1 hour |
| Phase 2: OAuth | 2.1, 2.2 | 3-4 hours |
| Phase 3: API Client | 3.1, 3.2 | 5-6 hours |
| Phase 4: CLI Commands | 4.1, 4.2, 4.3 | 4-5 hours |
| Phase 5: Testing | 5.1, 5.2 | 3-4 hours |
| **Total** | | **16-20 hours** |

---

## Dependencies and Prerequisites

1. **Atlassian Developer Console**: Register OAuth 2.0 app before Phase 2
2. **Confluence Cloud Account**: Needed for testing
3. **Check Jira Implementation**: May be able to share Atlassian OAuth code

---

## Open Questions

1. **Jira OAuth reuse**: Does the existing Jira implementation have reusable Atlassian OAuth code?
2. **Markdown conversion**: Should we provide storage format <-> Markdown conversion utilities?
3. **Data Center support**: Should we plan for DC support, or Cloud-only initially?

---

## File Checklist

Following the service development guidelines:

- [ ] `src/types/config.ts` - Add `confluence` to ServiceName
- [ ] `src/types/confluence.ts` - Create type definitions
- [ ] `src/config/credentials.ts` - Add Confluence OAuth config
- [ ] `src/auth/atlassian-oauth.ts` - Atlassian OAuth flow (or modify existing)
- [ ] `src/services/confluence/client.ts` - API client class
- [ ] `src/commands/confluence.ts` - CLI commands
- [ ] `src/utils/output.ts` - Add Confluence formatters
- [ ] `src/index.ts` - Register commands
