# Twitter/X Integration - Implementation Tasks

**Prerequisite:** Review `/Users/plosson/devel/projects/personal/agentio/.worktrees/twitter/docs/twitter_analysis.md` for API details and limitations.

---

## Phase 1: Foundation

### Task 1.1: Add Twitter to ServiceName type
**File:** `src/types/config.ts`
**Changes:**
- Add `'twitter'` to the `ServiceName` union type

**Estimated effort:** 5 minutes

---

### Task 1.2: Create Twitter types
**File:** `src/types/twitter.ts` (new file)
**Contents:**

```typescript
// Credentials - using OAuth 1.0a for simplicity (supports all features including media)
export interface TwitterCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  // Metadata
  username?: string;
  userId?: string;
}

// Tweet types
export interface TwitterTweet {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  createdAt: string;
  // Engagement metrics
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  // Threading
  conversationId?: string;
  inReplyToUserId?: string;
}

// Options
export interface TwitterSendOptions {
  text: string;
  replyTo?: string;  // Tweet ID to reply to
}

export interface TwitterListOptions {
  limit?: number;
  userId?: string;  // Default: authenticated user
}

// Results
export interface TwitterSendResult {
  id: string;
  text: string;
}

// API response types
export interface TwitterApiError {
  title: string;
  detail: string;
  type: string;
  status: number;
}
```

**Estimated effort:** 15 minutes

---

### Task 1.3: Create Twitter API client
**File:** `src/services/twitter/client.ts` (new file)
**Contents:**

Implement `TwitterClient` class with:

1. **Constructor:** Accept `TwitterCredentials`

2. **Private methods:**
   - `generateOAuthHeader(method: string, url: string, params?: Record<string, string>): string` - OAuth 1.0a signature generation
   - `request<T>(method: string, endpoint: string, body?: unknown): Promise<T>` - HTTP wrapper with auth
   - `getErrorCode(status: number): string` - Map HTTP status to error codes
   - `parseTweet(raw: unknown): TwitterTweet` - Parse API response

3. **Public methods:**
   - `async send(options: TwitterSendOptions): Promise<TwitterSendResult>` - POST /2/tweets
   - `async delete(tweetId: string): Promise<void>` - DELETE /2/tweets/:id
   - `async get(tweetId: string): Promise<TwitterTweet>` - GET /2/tweets/:id
   - `async list(options?: TwitterListOptions): Promise<TwitterTweet[]>` - GET /2/users/:id/tweets
   - `async getMe(): Promise<{ id: string; username: string }>` - GET /2/users/me

**Key implementation notes:**
- Use `https://api.x.com/2/` as base URL
- OAuth 1.0a requires HMAC-SHA1 signature (use Node crypto)
- Include `tweet.fields` parameter for rich tweet data
- Handle rate limiting with `RATE_LIMITED` error

**Estimated effort:** 2-3 hours

---

### Task 1.4: Implement OAuth 1.0a signature helper
**File:** `src/services/twitter/oauth.ts` (new file)
**Contents:**

```typescript
import crypto from 'crypto';

export function generateOAuth1Header(
  method: string,
  url: string,
  params: Record<string, string>,
  credentials: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  }
): string {
  // Implementation of OAuth 1.0a signature
  // 1. Generate nonce and timestamp
  // 2. Build signature base string
  // 3. Create signing key
  // 4. Generate HMAC-SHA1 signature
  // 5. Build Authorization header
}
```

**Estimated effort:** 1-2 hours (OAuth 1.0a is complex)

---

## Phase 2: Commands

### Task 2.1: Create Twitter commands
**File:** `src/commands/twitter.ts` (new file)
**Contents:**

Implement `registerTwitterCommands(program: Command)`:

**Operation commands:**

1. `twitter send [message]`
   - Options: `--profile <name>`, `--reply-to <id>`
   - Support stdin input
   - Print tweet ID and URL on success

2. `twitter delete <tweet-id>`
   - Options: `--profile <name>`
   - Confirm deletion, print success

3. `twitter get <tweet-id>`
   - Options: `--profile <name>`
   - Print formatted tweet

4. `twitter list`
   - Options: `--profile <name>`, `--limit <n>` (default 20)
   - Print formatted tweet list (user's tweets)

5. `twitter me`
   - Options: `--profile <name>`
   - Print authenticated user info (validate credentials)

**Profile commands:**

6. `twitter profile add`
   - Options: `--profile <name>`
   - Interactive prompts for: API Key, API Secret, Access Token, Access Token Secret
   - Validate credentials by calling `getMe()`
   - Store encrypted credentials

7. `twitter profile list`
   - Show all profiles with default marker
   - Show username for each profile

8. `twitter profile remove`
   - Options: `--profile <name>` (required)
   - Delete config and credentials

**Estimated effort:** 2-3 hours

---

### Task 2.2: Add output formatters
**File:** `src/utils/output.ts`
**Changes:**

Add functions:
```typescript
export function printTwitterTweet(tweet: TwitterTweet): void
export function printTwitterTweetList(tweets: TwitterTweet[]): void
export function printTwitterSendResult(result: TwitterSendResult): void
export function printTwitterProfile(profile: { username: string; userId: string }): void
```

**Format example for tweet:**
```
Tweet ID: 1234567890
Author: @username
Date: 2026-01-12 10:30:00
Text: This is the tweet content...
Likes: 5 | Retweets: 2 | Replies: 1
URL: https://x.com/username/status/1234567890
```

**Estimated effort:** 30 minutes

---

### Task 2.3: Register commands in index.ts
**File:** `src/index.ts`
**Changes:**
- Import `registerTwitterCommands` from `./commands/twitter`
- Call `registerTwitterCommands(program)` in registration block

**Estimated effort:** 5 minutes

---

## Phase 3: Testing and Documentation

### Task 3.1: Test profile management
**Tests:**
- [ ] `agentio twitter profile add` - creates profile with valid credentials
- [ ] `agentio twitter profile add` - fails with invalid credentials
- [ ] `agentio twitter profile list` - shows created profile
- [ ] `agentio twitter profile remove --profile test` - removes profile

**Estimated effort:** 30 minutes

---

### Task 3.2: Test operations
**Tests:**
- [ ] `agentio twitter me` - returns authenticated user info
- [ ] `agentio twitter send "test tweet"` - posts tweet, returns ID
- [ ] `echo "test" | agentio twitter send` - supports stdin
- [ ] `agentio twitter get <id>` - retrieves posted tweet
- [ ] `agentio twitter list --limit 5` - lists user's tweets
- [ ] `agentio twitter delete <id>` - deletes tweet

**Estimated effort:** 1 hour

---

### Task 3.3: Update CLAUDE.md
**File:** `CLAUDE.md`
**Changes:**
- Add Twitter to the list of services
- Add Twitter commands to the command reference
- Note the pricing/limitations in design decisions

**Estimated effort:** 15 minutes

---

## Implementation Order

1. **Task 1.1** - Add to ServiceName (5 min)
2. **Task 1.2** - Create types (15 min)
3. **Task 1.4** - OAuth helper (1-2 hours)
4. **Task 1.3** - API client (2-3 hours)
5. **Task 2.2** - Output formatters (30 min)
6. **Task 2.1** - Commands (2-3 hours)
7. **Task 2.3** - Register commands (5 min)
8. **Task 3.1** - Test profiles (30 min)
9. **Task 3.2** - Test operations (1 hour)
10. **Task 3.3** - Update docs (15 min)

**Total estimated effort:** 8-12 hours

---

## Dependencies and Libraries

No additional npm packages required. Use:
- Built-in `crypto` module for OAuth 1.0a signatures
- Built-in `fetch` for HTTP requests (available in Bun)

---

## Configuration Notes

### User Setup Required

Unlike Gmail (embedded OAuth), Twitter requires users to:

1. Create a developer account at https://developer.x.com
2. Create a Project and App
3. Generate API Key, API Secret
4. Generate Access Token, Access Token Secret (with Read/Write permissions)
5. Run `agentio twitter profile add` and enter credentials

### Credentials Storage

Store in encrypted token store:
```json
{
  "twitter": {
    "default": {
      "apiKey": "...",
      "apiSecret": "...",
      "accessToken": "...",
      "accessTokenSecret": "...",
      "username": "...",
      "userId": "..."
    }
  }
}
```

---

## Rate Limit Handling

The client should:
1. Check for HTTP 429 responses
2. Extract `x-rate-limit-reset` header
3. Throw `CliError('RATE_LIMITED', 'Rate limit exceeded', 'Wait until HH:MM:SS')`

---

## Future Enhancements (Not in Initial Scope)

- OAuth 2.0 support with PKCE flow (for scoped access)
- Media upload support (images, videos)
- Home timeline reading (requires Basic tier)
- Tweet search (requires Basic tier)
- Thread creation
- Bookmarks management
