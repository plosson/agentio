# Instagram API Analysis for agentio CLI Integration

**Date**: January 2025
**Status**: Research Complete

## Executive Summary

The Instagram API integration for agentio is **feasible but with significant limitations**. The official Instagram Graph
API supports Business and Creator accounts only, requires Facebook App Review approval, and has restrictive rate
limits (200 API calls/hour). Personal accounts are no longer supported via any public API since the Basic Display API
deprecation in December 2024.

## API Overview

### Available APIs

| API                         | Status                       | Purpose                                          |
|-----------------------------|------------------------------|--------------------------------------------------|
| Instagram Graph API         | Active                       | Full functionality for Business/Creator accounts |
| Instagram Messaging API     | Active                       | Direct message automation for businesses         |
| Instagram Basic Display API | **Deprecated** (Dec 4, 2024) | Was for personal account read-only access        |

### Supported Operations

**Content Publishing** (Business accounts only):

- Single image posts (JPEG only)
- Video posts (automatically published as Reels)
- Carousel posts (up to 10 images/videos)
- Reels (up to 90 seconds)
- Stories (since 2023)

**Reading Content**:

- List own media (photos, videos, reels)
- Get media details and metadata
- Read comments on own posts
- Get insights/analytics for own content
- Search hashtags (30 unique per 7 days)

**Comment Management**:

- Read comments
- Post comments
- Delete own comments

**Direct Messaging** (Messaging API):

- Send/receive DMs
- User must initiate contact first (24-hour window)
- 200 DMs/hour limit

**Not Supported**:

- Reading home feed (posts from accounts you follow)
- Fetching other users' followers/following lists
- Public content search (beyond hashtags)
- Instagram TV or Live publishing
- Deleting posts via API
- Personal account access

## Authentication Requirements

### Prerequisites

1. **Account Type**: Instagram Business or Creator account (free to convert)
2. **Facebook Integration**: Account must be connected to a Facebook Page
3. **Developer Account**: Meta for Developers account required
4. **Facebook App**: Must create and configure a Facebook App

### OAuth 2.0 Flow

Two authentication approaches available:

1. **Business Login** (simpler):
    - Authenticates directly through Instagram
    - Generates Instagram User access tokens
    - Best for single-account applications

2. **Facebook Login** (recommended for production):
    - Connects through Facebook Pages
    - Better for managing multiple accounts
    - Centralized control through Business Manager

### Token Lifecycle

- **Short-lived tokens**: ~1 hour expiry
- **Long-lived tokens**: 60 days expiry (can be refreshed after 24 hours)

### Required Permission Scopes

| Scope                       | Purpose                          |
|-----------------------------|----------------------------------|
| `instagram_basic`           | Read profile and media           |
| `instagram_content_publish` | Publish posts, videos, carousels |
| `instagram_manage_comments` | Read/write/delete comments       |
| `instagram_manage_insights` | Access analytics                 |
| `instagram_manage_messages` | DM functionality (Messaging API) |
| `pages_show_list`           | View managed Facebook Pages      |
| `pages_manage_metadata`     | Manage Page settings             |

## App Review Process

### Requirements for Production Use

1. **Development Mode**: Can test with own accounts immediately
2. **App Review**: Required before going live with external users

### Review Process Details

- Submit detailed explanation of app purpose and data usage
- Provide screencast video demonstrating functionality
- Must have valid Privacy Policy on a public website
- Each permission requires individual justification
- Generic/template submissions are rejected

### Timeline & Challenges

- Review typically takes **several weeks to months**
- Multiple rejections are common (developers report 2-4+ attempts)
- Rejection explanations can be vague
- No test users available (must use real accounts)

**Warning**: Switching to Live mode before approval revokes all data access.

## Rate Limits

| Operation          | Limit                              |
|--------------------|------------------------------------|
| API calls          | 200 per hour per Instagram account |
| Content publishing | 25 posts per 24 hours              |
| Hashtag searches   | 30 unique hashtags per 7 days      |
| Direct messages    | 200 per hour                       |
| DM window          | 24 hours (user must initiate)      |

**Note**: Rate limits were significantly reduced in 2025 (previously 5,000 calls/hour).

## Pricing

The Instagram Graph API is **free to use**. No paid tiers or API fees. However:

- Rate limits apply to all users equally
- No way to purchase higher limits
- Third-party wrapper services may charge fees

## Feasibility Assessment

### What We Can Build

1. **Profile Management**
    - Add/remove Instagram profiles
    - Store OAuth tokens securely

2. **Content Publishing** (Business accounts)
    - `instagram post` - Post single image
    - `instagram post-video` - Post video (as Reel)
    - `instagram post-carousel` - Post multiple images
    - `instagram post-story` - Post story

3. **Content Reading**
    - `instagram list` - List own recent posts
    - `instagram get <id>` - Get post details
    - `instagram comments <id>` - List comments on a post

4. **Comment Management**
    - `instagram comment <post-id> <text>` - Add comment
    - `instagram delete-comment <comment-id>` - Delete own comment

5. **Insights**
    - `instagram insights <id>` - Get post metrics
    - `instagram account-insights` - Get account metrics

### What We Cannot Build

- Reading home feed (no API access)
- Browsing other users' posts (no API access)
- DM inbox reading (requires Messaging API setup with webhooks)
- Personal account support (API deprecated)
- Content deletion (no API endpoint)

## Risks and Limitations

### Critical Limitations

1. **Business/Creator accounts only** - Users must convert their Instagram accounts and link to Facebook
2. **No home feed access** - Cannot read posts from followed accounts
3. **App Review bottleneck** - Production use requires Meta approval (weeks/months)
4. **Aggressive rate limits** - 200 calls/hour severely limits utility
5. **Facebook dependency** - Requires Facebook Page connection and Meta developer ecosystem

### Implementation Risks

1. **API volatility** - Meta frequently changes APIs with short notice (90 days typical)
2. **Deprecation risk** - Basic Display API was deprecated; Graph API could face similar changes
3. **Review rejection** - CLI tool use case may not align with Meta's expected use cases
4. **Token management** - Long-lived tokens still require periodic refresh (60 days)

### Competitive Comparison

| Feature           | Gmail        | Telegram  | Instagram            |
|-------------------|--------------|-----------|----------------------|
| Personal accounts | Yes          | Yes       | **No**               |
| App approval      | Simple OAuth | Bot token | **Complex review**   |
| Read feed/inbox   | Yes          | Yes       | **Own content only** |
| Send/post         | Yes          | Yes       | Yes (Business only)  |
| Rate limits       | Generous     | Generous  | **200/hour**         |
| Setup complexity  | Low          | Low       | **High**             |

## Recommendation

### Verdict: **Conditional Implementation**

Instagram integration is feasible but should be considered **low priority** due to:

1. **High barrier to entry** for users (must have Business/Creator account linked to Facebook)
2. **Limited functionality** compared to Gmail/Telegram (no feed reading)
3. **Complex setup** requiring Meta developer app and potentially App Review
4. **Restrictive rate limits** that may frustrate power users

### Recommended Approach

If proceeding, implement in phases:

**Phase 1 (MVP)**:

- Profile management with OAuth
- Content publishing (images, videos)
- List/get own posts

**Phase 2 (If demand exists)**:

- Comment management
- Insights/analytics
- Carousel and Story support

**Phase 3 (Advanced)**:

- DM support (requires webhook infrastructure)

### Alternative Consideration

For a CLI tool used by LLM agents, Instagram's limitations significantly reduce utility:

- Agents cannot read feeds or discover content
- Can only publish and read own content
- High setup overhead for users

Consider deprioritizing Instagram in favor of services with more complete API access (e.g., LinkedIn, Discord, or other
platforms with better developer support).

## Sources

- [Instagram Graph API: Complete Developer Guide for 2025](https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2025/)
- [Instagram API: A Complete Guide For Businesses In 2025](https://tagembed.com/blog/instagram-api/)
- [Instagram API 2026: Complete Developer Guide](https://getlate.dev/blog/instagram-api)
- [Instagram API Rate Limits: 200 DMs/Hour Explained (2025)](https://creatorflow.so/blog/instagram-api-rate-limits-explained/)
- [Instagram's API Rate Limits: A Deep Dive (2025)](https://www.marketingscoop.com/marketing/instagrams-api-rate-limits-a-deep-dive-for-developers-and-marketers-in-2024/)
- [Instagram API Pricing Explained](https://www.getphyllo.com/post/instagram-api-pricing-explained-iv)
- [Passing Facebook App Review for Instagram Permissions](https://blog.cbuelter.de/passing-facebook-app-review-for-instagram-permissions/)
- [A Complete Guide To the Instagram Reels API](https://www.getphyllo.com/post/a-complete-guide-to-the-instagram-reels-api)
- [Instagram Direct Messaging API | Sinch](https://sinch.com/apis/messaging/instagram/)
- [The guide to the Instagram DM API | Trengo](https://trengo.com/blog/instagram-dm-api)
