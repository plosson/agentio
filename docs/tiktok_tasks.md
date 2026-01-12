# TikTok Integration Task Breakdown

> **WARNING: Implementation Not Recommended**
>
> TikTok's developer guidelines explicitly exclude personal utility tools:
> "Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages."
>
> This task breakdown is provided for reference only. Proceeding with implementation will likely result in app rejection or post-approval revocation.

## Prerequisites (External Blockers)

- [ ] **BLOCKER**: Obtain TikTok developer app approval (likely to be rejected)
- [ ] **BLOCKER**: Pass Content Posting API audit for direct publishing
- [ ] Setup public HTTPS domain for OAuth callbacks (TikTok doesn't support localhost)
- [ ] Verify geographic eligibility for API access

## Implementation Tasks

Following the project's [Service Development Guidelines](../CLAUDE.md):

### Phase 1: Type Definitions

**Task 1.1: Add TikTok to ServiceName type**
- File: `src/types/config.ts`
- Add `'tiktok'` to `ServiceName` union type

**Task 1.2: Create TikTok type definitions**
- File: `src/types/tiktok.ts`
- Define interfaces:
  ```typescript
  interface TikTokCredentials {
    accessToken: string;
    refreshToken: string;
    expiryDate: number;
    openId: string;
  }

  interface TikTokUserInfo {
    openId: string;
    displayName: string;
    avatarUrl: string;
    profileDeepLink: string;
    bioDescription?: string;
  }

  interface TikTokVideo {
    id: string;
    title: string;
    description: string;
    duration: number;
    createTime: number;
    shareUrl: string;
    coverImageUrl: string;
    viewCount?: number;
    likeCount?: number;
    commentCount?: number;
    shareCount?: number;
  }

  interface TikTokPostOptions {
    videoPath: string;
    title?: string;
    privacyLevel?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
    disableDuet?: boolean;
    disableStitch?: boolean;
    disableComment?: boolean;
  }

  interface TikTokPostResult {
    publishId: string;
    status: 'PROCESSING_UPLOAD' | 'PROCESSING_DOWNLOAD' | 'PUBLISH_COMPLETE' | 'FAILED';
  }

  interface TikTokListOptions {
    limit?: number;
    cursor?: number;
  }
  ```

### Phase 2: API Client

**Task 2.1: Create TikTok OAuth handler**
- File: `src/auth/tiktok-oauth.ts`
- Implement OAuth 2.0 with PKCE flow
- Handle token refresh (24hr access token, 1yr refresh token)
- Note: Cannot use localhost - requires HTTPS public domain

**Task 2.2: Create TikTok client**
- File: `src/services/tiktok/client.ts`
- Implement `TikTokClient` class with methods:
  ```typescript
  class TikTokClient {
    // Display API
    async getUserInfo(): Promise<TikTokUserInfo>
    async listVideos(options?: TikTokListOptions): Promise<TikTokVideo[]>
    async getVideo(videoId: string): Promise<TikTokVideo>

    // Content Posting API
    async postVideo(options: TikTokPostOptions): Promise<TikTokPostResult>
    async getPostStatus(publishId: string): Promise<TikTokPostResult>

    // Private helpers
    private async request<T>(endpoint: string, options: RequestInit): Promise<T>
    private getErrorCode(status: number): string
    private async refreshTokenIfNeeded(): Promise<void>
  }
  ```

### Phase 3: Commands

**Task 3.1: Create TikTok commands**
- File: `src/commands/tiktok.ts`
- Implement commands:
  ```
  agentio tiktok list [--limit N] [--cursor N]
  agentio tiktok get <video-id>
  agentio tiktok post <video-path> [--title <title>] [--privacy <level>]
  agentio tiktok status <publish-id>
  agentio tiktok profile add [--profile <name>]
  agentio tiktok profile list
  agentio tiktok profile remove --profile <name>
  ```

**Task 3.2: Implement profile management**
- OAuth flow with browser redirect (requires HTTPS)
- Store tokens encrypted in token store
- Handle token refresh on operations

### Phase 4: Output Formatting

**Task 4.1: Add TikTok formatters**
- File: `src/utils/output.ts`
- Add functions:
  ```typescript
  printTikTokUserInfo(user: TikTokUserInfo): void
  printTikTokVideoList(videos: TikTokVideo[]): void
  printTikTokVideo(video: TikTokVideo): void
  printTikTokPostResult(result: TikTokPostResult): void
  ```

### Phase 5: Integration

**Task 5.1: Register commands**
- File: `src/index.ts`
- Import and call `registerTikTokCommands(program)`

**Task 5.2: Update token manager for TikTok OAuth**
- File: `src/auth/token-manager.ts`
- Add TikTok token refresh logic (different from Gmail OAuth)

### Phase 6: Testing

**Task 6.1: Test in sandbox mode**
- Create TikTok sandbox app (max 10 test accounts)
- Note: Direct Post not available in sandbox
- Test OAuth flow, video listing, draft upload

**Task 6.2: Test profile management**
- `profile add` - OAuth authorization
- `profile list` - Display profiles
- `profile remove` - Clean up credentials

## Technical Challenges

### OAuth Without Localhost

TikTok requires HTTPS callbacks. Options:
1. Use ngrok for local development (`ngrok http 3000`)
2. Deploy callback handler to cloud
3. Use dynamic port with ngrok tunnel per session

### Video Upload Flow

Content Posting uses a multi-step process:
1. Initialize upload (get upload URL)
2. Upload video file to URL
3. Finalize post with metadata
4. Poll status until complete

### Rate Limit Handling

Implement exponential backoff for:
- 6 requests/minute per user token
- HTTP 429 responses
- 2 videos/minute publishing limit
- 20 videos/day limit

## Estimated Effort

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| Prerequisites | External approval | Weeks to Never |
| Phase 1 | Types | 1-2 hours |
| Phase 2 | Client | 4-6 hours |
| Phase 3 | Commands | 3-4 hours |
| Phase 4 | Output | 1 hour |
| Phase 5 | Integration | 1 hour |
| Phase 6 | Testing | 2-3 hours |
| **Total** | | **12-17 hours** (excluding approval) |

## Decision Point

Before investing development time:

1. **Do not proceed** unless you have:
   - A legitimate business entity
   - A use case that serves "wide audience"
   - HTTPS infrastructure for OAuth

2. **Consider alternatives**:
   - Third-party aggregator APIs (SocialKit, Ensembledata)
   - Skip TikTok and focus on text-friendly services
   - Wait for potential policy changes

3. **If proceeding anyway**:
   - Start with Display API only (read operations)
   - Accept sandbox limitations
   - Do not expect audit approval for publishing
