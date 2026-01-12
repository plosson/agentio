# Threads (Meta) API Analysis for agentio CLI

## Executive Summary

Meta's Threads API is a **publicly available, free API** that launched on June 18, 2024. It provides comprehensive functionality for posting content, managing replies, and accessing analytics. The API is well-suited for integration into agentio CLI, following similar patterns to the existing Telegram integration.

**Recommendation: PROCEED WITH IMPLEMENTATION**

---

## API Overview

### Release Timeline
- **October 2023**: Initial API announcement by Adam Mosseri
- **March 2024**: Closed beta with partners (Sprinklr, Sprout Social, Hootsuite)
- **April 2024**: Developer documentation published, signups opened
- **June 18, 2024**: Public API launch at Cannes Lions Festival
- **October 2024**: Webhooks and real-time notifications added
- **December 2024**: Advanced search and analytics features
- **July 2025**: Enhanced public profile access and polls API

### Base URL
```
https://graph.threads.net
```

### Core Capabilities

| Feature | Supported | Notes |
|---------|-----------|-------|
| Publish text posts | Yes | Two-step container flow |
| Publish images | Yes | JPEG, PNG formats |
| Publish videos | Yes | Up to 5 minutes |
| Carousel posts | Yes | Up to 20 images/videos |
| Read own threads | Yes | With pagination |
| Read public profiles | Yes | Added July 2025 |
| Reply management | Yes | Hide/unhide, respond |
| Analytics/Insights | Yes | Views, likes, reposts, quotes |
| Polls | Yes | Added July 2025 |

---

## Authentication

### Method: OAuth 2.0

The Threads API uses standard OAuth 2.0 authentication flow through Instagram's authorization system.

### Authorization Flow

1. **Redirect user to authorization URL:**
   ```
   https://threads.net/oauth/authorize
     ?client_id={APP_ID}
     &redirect_uri={CALLBACK_URL}
     &scope={SCOPES}
     &response_type=code
   ```

2. **Exchange code for short-lived token (1 hour):**
   ```
   POST https://graph.threads.net/oauth/access_token
   Body: client_id, client_secret, grant_type, redirect_uri, code
   ```

3. **Exchange for long-lived token (60 days):**
   ```
   GET https://graph.threads.net/access_token
     ?grant_type=th_exchange_token
     &client_secret={SECRET}
     &access_token={SHORT_TOKEN}
   ```

### Required Scopes

| Scope | Purpose |
|-------|---------|
| `threads_basic` | Read profile info and posted media |
| `threads_content_publish` | Publish posts |
| `threads_read_replies` | Read replies to posts |
| `threads_manage_replies` | Hide/unhide/respond to replies |
| `threads_manage_insights` | Access analytics data |

### Developer Requirements

- Meta Developer account required
- Business account verification required
- Meta App with Threads API enabled
- Configure OAuth callback URLs
- Add Threads testers during development

---

## API Endpoints

### Publishing (Two-Step Process)

**Step 1: Create media container**
```
POST /v1.0/{user_id}/threads
Parameters:
  - media_type: TEXT, IMAGE, VIDEO, CAROUSEL
  - text: Post content
  - image_url / video_url: Media URL (for media posts)
```

**Step 2: Publish container**
```
POST /v1.0/{user_id}/threads_publish
Parameters:
  - creation_id: Container ID from step 1
```

### Reading Content

**List user's threads:**
```
GET /v1.0/me/threads
Fields: id, media_type, text, timestamp, permalink, username
```

**Get specific thread:**
```
GET /v1.0/{thread_id}
Fields: id, text, timestamp, permalink, media_url, etc.
```

### Reply Management

```
GET /v1.0/{thread_id}/replies
GET /v1.0/{thread_id}/conversation
POST /v1.0/{reply_id}?hide=true|false
```

### Insights

```
GET /v1.0/{media_id}/insights
Metrics: views, likes, replies, reposts, quotes
```

---

## Rate Limits

| Resource | Limit | Period |
|----------|-------|--------|
| API-published posts | 250 | 24 hours (rolling) |
| Replies | 1,000 | 24 hours |
| App access token requests | 5,000,000 | 24 hours |
| Hashtags per post | 1 | Per post |

**Note:** Rate limits are per-profile, not per-app.

---

## Pricing

**FREE** - The Threads API has no usage fees. Meta provides free access to all developers, contrasting with Twitter/X's paid API model.

---

## Feasibility Assessment

### Alignment with agentio Architecture

| Aspect | Assessment |
|--------|------------|
| OAuth flow | Similar to Gmail, can reuse `oauth.ts` patterns |
| Token storage | Compatible with existing `token-store.ts` (encrypted AES-256-GCM) |
| Command structure | Matches existing Gmail/Telegram patterns |
| Multi-profile | Fully supported |

### Implementation Complexity

| Component | Complexity | Notes |
|-----------|------------|-------|
| Authentication | Medium | OAuth browser flow, token refresh needed |
| Posting | Low | Well-documented two-step process |
| Reading | Low | Simple GET endpoints |
| Reply management | Low | Standard REST operations |
| Insights | Low | Optional enhancement |

### Required Meta App Setup

Users will need to:
1. Create a Meta Developer account
2. Create a Meta App with Threads API access
3. Configure OAuth callback URLs
4. Provide App ID and App Secret during profile setup

**Alternative**: Embed OAuth credentials (like Gmail) - would require Meta app review and approval for public distribution.

---

## Risks and Limitations

### Technical Risks

1. **OAuth Complexity**: Requires browser-based authorization flow (similar to Gmail)
2. **Token Expiration**: Long-lived tokens expire after 60 days; need refresh mechanism
3. **Business Account Requirement**: Users must have Meta business verification
4. **Two-Step Publishing**: More complex than single-call APIs

### Platform Risks

1. **API Maturity**: API launched June 2024, still evolving
2. **Breaking Changes**: Endpoints may change as platform matures
3. **Feature Parity**: Some features (like reading other users' public posts) are newer

### Limitations

1. **No DMs**: API does not support direct messages
2. **Own Content Only**: Limited ability to read other users' content (public profiles only since July 2025)
3. **Single Hashtag**: Only 1 hashtag allowed per post
4. **Business Verification**: Required for API access
5. **No Real-Time Feed**: Cannot stream new posts from followed accounts

---

## Recommended Scope for agentio Integration

### Phase 1 (MVP)
- Profile management (add/list/remove)
- Send text posts
- Send image posts
- List own threads
- Get specific thread

### Phase 2 (Enhancement)
- Reply to threads
- Send carousel posts
- Reply management (hide/unhide)
- Insights/analytics

### Not Recommended
- Reading other users' posts (limited utility, added complexity)
- Webhooks (requires server infrastructure)

---

## Comparison with Existing Services

| Feature | Gmail | Telegram | Threads |
|---------|-------|----------|---------|
| Auth type | OAuth 2.0 | Bot token | OAuth 2.0 |
| Token refresh | Yes | No | Yes (60 days) |
| Embedded creds | Yes | N/A | Possible (needs review) |
| Send messages | Yes | Yes | Yes |
| Read messages | Yes | No | Yes (own only) |
| Attachments | Yes | Yes | Yes |
| Rate limits | Complex | Low | 250 posts/day |

---

## Sources

- [TechCrunch: Threads finally launches its API](https://techcrunch.com/2024/06/18/threads-finally-launches-its-api-for-developers/)
- [Meta expands Threads API with advanced features](https://ppc.land/meta-expands-threads-api-with-advanced-features-for-developers/)
- [Threads API Authentication Guide](https://blog.nevinpjohn.in/posts/threads-api-public-authentication/)
- [Postman Threads API Documentation](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api)
- [threads-graph-api GitHub](https://github.com/spoolappio/threads-graph-api)
- [A Developer's Guide to the Threads API](https://getlate.dev/blog/threads-api)
