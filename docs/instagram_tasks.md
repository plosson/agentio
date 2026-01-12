# Instagram Service Implementation Tasks

**Based on**: agentio Service Development Guidelines
**Priority**: Low (due to API limitations documented in `instagram_analysis.md`)
**Estimated Effort**: 3-5 days

## Prerequisites

Before starting implementation:
- [ ] Obtain Meta for Developers account
- [ ] Create Facebook App configured for Instagram
- [ ] Have test Instagram Business/Creator account linked to Facebook Page
- [ ] Understand that App Review will be needed for production use

---

## Phase 1: Core Infrastructure

### Task 1.1: Add Service Type Definition
**File**: `src/types/config.ts`

- [ ] Add `'instagram'` to the `ServiceName` union type
- [ ] Add `instagram?: string[]` to `profiles` interface
- [ ] Add `instagram?: string` to `defaults` interface

### Task 1.2: Create Instagram Types
**File**: `src/types/instagram.ts` (new file)

Define interfaces following project patterns:

```typescript
// Credentials interface for OAuth tokens
export interface InstagramCredentials {
  accessToken: string;
  userId: string;           // Instagram User ID
  username?: string;        // For display
  accountType: 'BUSINESS' | 'CREATOR';
  expiresAt?: number;       // Token expiry timestamp
}

// Media types
export interface InstagramMedia {
  id: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REELS';
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink: string;
  caption?: string;
  timestamp: string;
  likeCount?: number;
  commentsCount?: number;
}

// Comment type
export interface InstagramComment {
  id: string;
  text: string;
  username: string;
  timestamp: string;
  likeCount?: number;
}

// Publishing options
export interface InstagramPostOptions {
  imageUrl?: string;        // Public URL for image
  videoUrl?: string;        // Public URL for video
  caption?: string;
  mediaType?: 'IMAGE' | 'VIDEO' | 'REELS';
}

export interface InstagramCarouselOptions {
  mediaUrls: string[];      // Array of public URLs
  caption?: string;
}

// API response types
export interface InstagramPostResult {
  id: string;
  permalink?: string;
}

export interface InstagramListOptions {
  limit?: number;
  after?: string;           // Pagination cursor
}
```

### Task 1.3: Create Instagram API Client
**File**: `src/services/instagram/client.ts` (new file)

Implement `InstagramClient` class with methods:

- [ ] `constructor(credentials: InstagramCredentials)`
- [ ] `async getProfile(): Promise<InstagramProfile>` - Verify token and get account info
- [ ] `async listMedia(options?: InstagramListOptions): Promise<InstagramMedia[]>` - List own posts
- [ ] `async getMedia(mediaId: string): Promise<InstagramMedia>` - Get single post details
- [ ] `async postImage(options: InstagramPostOptions): Promise<InstagramPostResult>` - Post single image
- [ ] `async postVideo(options: InstagramPostOptions): Promise<InstagramPostResult>` - Post video/Reel
- [ ] `async postCarousel(options: InstagramCarouselOptions): Promise<InstagramPostResult>` - Post carousel
- [ ] `async getComments(mediaId: string): Promise<InstagramComment[]>` - List comments
- [ ] `async addComment(mediaId: string, text: string): Promise<InstagramComment>` - Add comment
- [ ] `async deleteComment(commentId: string): Promise<void>` - Delete own comment

Private helpers:
- [ ] `private async request<T>(endpoint: string, options?: RequestInit): Promise<T>` - HTTP wrapper with error handling
- [ ] `private getErrorCode(status: number): string` - Map HTTP status to error codes
- [ ] `private async createMediaContainer(options: InstagramPostOptions): Promise<string>` - Create upload container
- [ ] `private async waitForContainerReady(containerId: string): Promise<void>` - Poll container status
- [ ] `private async publishContainer(containerId: string): Promise<InstagramPostResult>` - Publish container

API base URL: `https://graph.instagram.com/v22.0`

---

## Phase 2: Authentication

### Task 2.1: Create Instagram OAuth Flow
**File**: `src/auth/instagram-oauth.ts` (new file)

Implement OAuth 2.0 flow:

- [ ] Define embedded OAuth client credentials (or document user setup)
- [ ] `async startOAuthFlow(): Promise<string>` - Generate auth URL and start local server
- [ ] `async handleCallback(code: string): Promise<InstagramCredentials>` - Exchange code for tokens
- [ ] `async refreshToken(credentials: InstagramCredentials): Promise<InstagramCredentials>` - Refresh expired tokens

OAuth endpoints:
- Authorization: `https://www.instagram.com/oauth/authorize`
- Token exchange: `https://api.instagram.com/oauth/access_token`
- Token refresh: `https://graph.instagram.com/refresh_access_token`

Required scopes:
- `instagram_basic`
- `instagram_content_publish`
- `instagram_manage_comments`
- `instagram_manage_insights`

### Task 2.2: Add Token Validation
**File**: Extend existing `src/auth/token-manager.ts`

- [ ] Add `validateInstagramToken(credentials: InstagramCredentials): Promise<boolean>`
- [ ] Add `refreshInstagramToken(credentials: InstagramCredentials): Promise<InstagramCredentials | null>`

---

## Phase 3: CLI Commands

### Task 3.1: Create Command Handler
**File**: `src/commands/instagram.ts` (new file)

Implement `registerInstagramCommands(program: Command)`:

**Content Commands**:
- [ ] `instagram list [--limit N]` - List recent posts
- [ ] `instagram get <media-id>` - Get post details
- [ ] `instagram post [--image <url>] [--caption <text>]` - Post image
- [ ] `instagram post-video [--video <url>] [--caption <text>]` - Post video/Reel
- [ ] `instagram post-carousel [--media <urls...>] [--caption <text>]` - Post carousel

**Comment Commands**:
- [ ] `instagram comments <media-id>` - List comments on a post
- [ ] `instagram comment <media-id> [message]` - Add comment (supports stdin)
- [ ] `instagram delete-comment <comment-id>` - Delete own comment

**Insights Commands** (optional):
- [ ] `instagram insights <media-id>` - Get post metrics
- [ ] `instagram account-insights` - Get account-level metrics

**Profile Commands**:
- [ ] `instagram profile add [--profile <name>]` - OAuth flow to add profile
- [ ] `instagram profile list` - List configured profiles
- [ ] `instagram profile remove --profile <name>` - Remove profile

### Task 3.2: Implement Client Factory
**File**: `src/commands/instagram.ts`

```typescript
async function getInstagramClient(profileName?: string): Promise<{
  client: InstagramClient;
  profile: string
}>
```

Following the pattern from other services:
- Get profile from config
- Retrieve credentials from token store
- Validate/refresh token if needed
- Return client instance

---

## Phase 4: Output Formatting

### Task 4.1: Add Output Functions
**File**: `src/utils/output.ts`

Add formatters:

- [ ] `printInstagramMediaList(media: InstagramMedia[]): void`
- [ ] `printInstagramMedia(media: InstagramMedia): void`
- [ ] `printInstagramPostResult(result: InstagramPostResult): void`
- [ ] `printInstagramComments(comments: InstagramComment[]): void`
- [ ] `printInstagramProfile(profile: InstagramProfile): void`

Follow existing patterns:
- Use `console.log()` for success output (stdout)
- Format dates in human-readable form
- Include relevant metadata (media type, engagement counts)

---

## Phase 5: Registration and Testing

### Task 5.1: Register Commands
**File**: `src/index.ts`

- [ ] Import `registerInstagramCommands`
- [ ] Call `registerInstagramCommands(program)` in appropriate location

### Task 5.2: Manual Testing

Test all commands with a real Business/Creator account:

- [ ] Profile add/list/remove
- [ ] List media
- [ ] Get single media
- [ ] Post image (requires publicly accessible URL)
- [ ] Post video
- [ ] Post carousel
- [ ] List/add/delete comments
- [ ] Verify error handling (invalid token, rate limits, etc.)

### Task 5.3: Update Help and Documentation

- [ ] Ensure `--help` output is accurate for all commands
- [ ] Update `CLAUDE.md` with Instagram command examples

---

## Implementation Notes

### Error Codes to Handle

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 400 | `INVALID_PARAMS` | Bad request parameters |
| 401 | `AUTH_FAILED` | Invalid or expired token |
| 403 | `PERMISSION_DENIED` | Missing required scope |
| 404 | `NOT_FOUND` | Media/comment not found |
| 429 | `RATE_LIMITED` | Rate limit exceeded (200/hour) |
| 5xx | `API_ERROR` | Instagram server error |

### Content Publishing Flow

Instagram uses a two-step publishing process:

1. **Create Container**: Upload media URL, get container ID
2. **Wait for Processing**: Poll container status until ready
3. **Publish**: Convert container to published post

```typescript
// Pseudocode for publishing
const containerId = await createMediaContainer({ imageUrl, caption });
await waitForContainerReady(containerId);  // Poll until status is "FINISHED"
const result = await publishContainer(containerId);
```

### Rate Limit Handling

- Track API calls per hour
- Return helpful error with retry suggestion on 429
- Consider adding `--wait` flag to auto-retry after limit resets

### Media URL Requirements

Instagram API requires media to be hosted at publicly accessible URLs:
- Must be HTTPS
- Must be directly accessible (no redirects)
- Images must be JPEG format
- Videos must meet Instagram's encoding requirements

Consider documenting this requirement clearly in help text.

---

## Future Enhancements (Out of Scope)

These features are not included in the initial implementation:

1. **Story Publishing** - Requires additional API endpoints
2. **Direct Messages** - Requires Messaging API with webhook infrastructure
3. **Insights/Analytics** - Can be added in a later phase
4. **Scheduled Publishing** - Requires storing scheduled posts locally

---

## Checklist Summary

- [ ] Add `instagram` to `ServiceName` type in `src/types/config.ts`
- [ ] Create `src/types/instagram.ts` with all interfaces
- [ ] Create `src/services/instagram/client.ts` with `InstagramClient`
- [ ] Create `src/auth/instagram-oauth.ts` for OAuth flow
- [ ] Create `src/commands/instagram.ts` with all commands
- [ ] Add output formatters to `src/utils/output.ts`
- [ ] Register commands in `src/index.ts`
- [ ] Test all operations manually
- [ ] Update CLAUDE.md with Instagram commands
