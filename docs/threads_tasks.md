# Threads API Implementation Tasks

This document outlines all implementation steps for adding Threads (Meta) support to agentio CLI, following the project's service development guidelines.

---

## Phase 1: Core Infrastructure

### 1.1 Add Service Name to Config Types
**File:** `src/types/config.ts`

- [ ] Add `'threads'` to `ServiceName` union type

**Estimated time:** 5 minutes

---

### 1.2 Create Threads Types
**File:** `src/types/threads.ts`

- [ ] Define `ThreadsCredentials` interface:
  ```typescript
  export interface ThreadsCredentials {
    accessToken: string;
    refreshToken?: string;  // Not provided by Threads, but keeping for pattern consistency
    expiryDate: number;
    userId: string;
    username?: string;
  }
  ```

- [ ] Define `ThreadsThread` interface (message type):
  ```typescript
  export interface ThreadsThread {
    id: string;
    mediaType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';
    text?: string;
    mediaUrl?: string;
    permalink: string;
    timestamp: string;
    username: string;
    isQuotePost?: boolean;
  }
  ```

- [ ] Define `ThreadsSendOptions` interface:
  ```typescript
  export interface ThreadsSendOptions {
    text: string;
    imageUrl?: string;
    videoUrl?: string;
  }
  ```

- [ ] Define `ThreadsSendResult` interface:
  ```typescript
  export interface ThreadsSendResult {
    id: string;
    permalink?: string;
  }
  ```

- [ ] Define `ThreadsListOptions` interface:
  ```typescript
  export interface ThreadsListOptions {
    limit?: number;
    after?: string;
    before?: string;
  }
  ```

**Estimated time:** 30 minutes

---

### 1.3 Create OAuth Flow for Threads
**File:** `src/auth/threads-oauth.ts`

- [ ] Create `ThreadsOAuth` class or extend existing OAuth utilities
- [ ] Implement authorization URL generation:
  - Base URL: `https://threads.net/oauth/authorize`
  - Required params: `client_id`, `redirect_uri`, `scope`, `response_type=code`
  - Scopes: `threads_basic`, `threads_content_publish`

- [ ] Implement short-lived token exchange:
  - POST to `https://graph.threads.net/oauth/access_token`
  - Body: `client_id`, `client_secret`, `grant_type`, `redirect_uri`, `code`

- [ ] Implement long-lived token exchange:
  - GET `https://graph.threads.net/access_token`
  - Params: `grant_type=th_exchange_token`, `client_secret`, `access_token`

- [ ] Handle token refresh (long-lived tokens last 60 days)

- [ ] Reuse dynamic port allocation from `src/auth/oauth.ts` (ports 3000-3010)

**Estimated time:** 2-3 hours

---

## Phase 2: API Client

### 2.1 Create Threads Client
**File:** `src/services/threads/client.ts`

- [ ] Create `ThreadsClient` class with constructor accepting `ThreadsCredentials`

- [ ] Implement private `request<T>()` method:
  - Base URL: `https://graph.threads.net`
  - Include access token in all requests
  - Handle HTTP error codes → `CliError` mapping

- [ ] Implement `send(options: ThreadsSendOptions): Promise<ThreadsSendResult>`:
  - **Step 1:** Create media container
    - POST `/v1.0/{user_id}/threads`
    - Body: `{ media_type: 'TEXT', text: options.text }`
  - **Step 2:** Publish container
    - POST `/v1.0/{user_id}/threads_publish`
    - Body: `{ creation_id: containerId }`

- [ ] Implement `sendImage(options)` for image posts:
  - Media type: `IMAGE`
  - Include `image_url` parameter

- [ ] Implement `list(options?: ThreadsListOptions): Promise<ThreadsThread[]>`:
  - GET `/v1.0/me/threads`
  - Fields: `id,media_type,text,timestamp,permalink,username`
  - Handle pagination with `after`/`before` cursors

- [ ] Implement `get(id: string): Promise<ThreadsThread>`:
  - GET `/v1.0/{thread_id}`
  - Fields: `id,media_type,text,timestamp,permalink,username,media_url`

- [ ] Implement `getPublishingLimit(): Promise<{quota_usage: number, quota_total: number}>`:
  - GET `/v1.0/me/threads_publishing_limit`
  - Useful for checking rate limits

- [ ] Implement private `parseThread(raw: unknown): ThreadsThread`

- [ ] Implement private `getErrorCode(status: number): string`:
  - 401 → `AUTH_FAILED`
  - 403 → `PERMISSION_DENIED`
  - 404 → `NOT_FOUND`
  - 429 → `RATE_LIMITED`
  - Default → `API_ERROR`

**Estimated time:** 3-4 hours

---

## Phase 3: CLI Commands

### 3.1 Create Threads Commands
**File:** `src/commands/threads.ts`

- [ ] Implement `registerThreadsCommands(program: Command)`:

- [ ] Create `threads` parent command:
  ```typescript
  const threads = program
    .command('threads')
    .description('Threads (Meta) operations');
  ```

#### Operation Commands

- [ ] **send** command:
  ```
  threads send [message] [--profile <name>] [--image <url>]
  ```
  - Support stdin for message body
  - Validate message is provided

- [ ] **list** command:
  ```
  threads list [--limit N] [--profile <name>]
  ```
  - Default limit: 25

- [ ] **get** command:
  ```
  threads get <thread-id> [--profile <name>]
  ```

- [ ] **limit** command (check publishing quota):
  ```
  threads limit [--profile <name>]
  ```

#### Profile Commands

- [ ] **profile add** command:
  ```
  threads profile add [--profile <name>]
  ```
  - Prompt for Meta App ID and Secret (or use embedded if available)
  - Launch OAuth flow in browser
  - Exchange code for tokens
  - Validate by fetching user profile
  - Store credentials encrypted

- [ ] **profile list** command:
  ```
  threads profile list
  ```
  - Show all profiles with default marker
  - Display username metadata

- [ ] **profile remove** command:
  ```
  threads profile remove --profile <name>
  ```
  - Delete config and credentials

- [ ] Implement `getThreadsClient(profileName?)` factory function

**Estimated time:** 3-4 hours

---

## Phase 4: Output Formatting

### 4.1 Add Output Formatters
**File:** `src/utils/output.ts`

- [ ] Implement `printThreadsSendResult(result: ThreadsSendResult)`:
  ```
  Thread posted successfully
  ID: 12345678901234567
  URL: https://threads.net/@username/post/abc123
  ```

- [ ] Implement `printThreadsList(threads: ThreadsThread[])`:
  ```
  Found 5 threads:

  [1] 2024-01-15 14:30
      Hello world! This is my first thread.
      https://threads.net/@username/post/abc123

  [2] 2024-01-14 10:15
      Another post with an image
      https://threads.net/@username/post/def456
  ```

- [ ] Implement `printThreadsThread(thread: ThreadsThread)`:
  - Full thread details for `get` command

- [ ] Implement `printThreadsPublishingLimit(limit)`:
  ```
  Publishing limit: 45/250 posts used (24h rolling)
  ```

**Estimated time:** 1 hour

---

## Phase 5: Integration

### 5.1 Register Commands
**File:** `src/index.ts`

- [ ] Import `registerThreadsCommands` from `src/commands/threads.ts`
- [ ] Call `registerThreadsCommands(program)` in CLI setup

**Estimated time:** 5 minutes

---

## Phase 6: Testing

### 6.1 Manual Testing

- [ ] Test `threads profile add` - OAuth flow works
- [ ] Test `threads profile list` - shows added profile
- [ ] Test `threads send "Hello from agentio"` - posts successfully
- [ ] Test `threads send --image <url> "Post with image"` - image posts work
- [ ] Test `threads list` - returns recent threads
- [ ] Test `threads get <id>` - retrieves specific thread
- [ ] Test `threads limit` - shows quota usage
- [ ] Test `threads profile remove` - removes profile
- [ ] Test error handling:
  - Invalid credentials (AUTH_FAILED)
  - Rate limited (RATE_LIMITED)
  - No profile configured (PROFILE_NOT_FOUND)

### 6.2 Edge Cases

- [ ] Test stdin input: `echo "Hello" | agentio threads send`
- [ ] Test with multiple profiles
- [ ] Test token expiration handling (after 60 days)

**Estimated time:** 2-3 hours

---

## Summary

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| 1. Infrastructure | Config type, Threads types, OAuth | 3-4 hours |
| 2. API Client | ThreadsClient implementation | 3-4 hours |
| 3. CLI Commands | Commands and profile management | 3-4 hours |
| 4. Output | Formatters in output.ts | 1 hour |
| 5. Integration | Register in index.ts | 5 minutes |
| 6. Testing | Manual and edge case testing | 2-3 hours |

**Total Estimated Time:** 12-16 hours

---

## Files to Create/Modify

### New Files
- `src/types/threads.ts`
- `src/auth/threads-oauth.ts`
- `src/services/threads/client.ts`
- `src/commands/threads.ts`

### Modified Files
- `src/types/config.ts` - Add 'threads' to ServiceName
- `src/utils/output.ts` - Add Threads formatters
- `src/index.ts` - Register Threads commands

---

## Decision Points

### 1. OAuth Credentials Strategy
**Options:**
- **A) User-provided credentials**: Users create their own Meta App and provide App ID/Secret during profile setup
- **B) Embedded credentials**: Embed agentio Meta App credentials (requires Meta app review)

**Recommendation:** Start with Option A (user-provided) for MVP. Consider Option B later if demand warrants Meta app review process.

### 2. Token Refresh Strategy
**Options:**
- **A) Manual refresh**: User runs `profile add` again after 60 days
- **B) Automatic refresh**: Detect expired tokens and refresh automatically

**Recommendation:** Option B (automatic refresh) for better UX, similar to Gmail pattern.

### 3. Image/Video Handling
**Options:**
- **A) URL only**: Require user to provide publicly accessible URL
- **B) File upload**: Upload local files to a hosting service first

**Recommendation:** Option A (URL only) for MVP simplicity. Threads API requires public URLs anyway.
