# TikTok API Integration Analysis

**Date:** January 2026
**Purpose:** Evaluate feasibility of integrating TikTok into the agentio CLI

## 1. API Overview

TikTok provides several official APIs for developers through the [TikTok for Developers](https://developers.tiktok.com/) portal:

### Available APIs

| API | Purpose | Access Level |
|-----|---------|--------------|
| **Login Kit** | OAuth 2.0 authentication with PKCE | Standard app approval |
| **Display API** | Read user profile and video metadata | Standard app approval |
| **Content Posting API** | Upload videos (draft or direct post) | Requires audit for public posts |
| **Research API** | Academic/research access to TikTok data | Requires research credentials |
| **Commercial Content API** | Advertising/branded content | Business accounts only |

### Relevant Endpoints for agentio

**Read Operations (Display API):**
- `GET /v2/user/info/` - User profile (avatar, display name, bio)
- `GET /v2/video/list/` - List user's recent videos
- `GET /v2/video/query/` - Query specific videos by ID

**Write Operations (Content Posting API):**
- `POST /v2/post/publish/video/init/` - Initialize direct video post
- `POST /v2/post/publish/content/init/` - Upload video as draft
- `GET /v2/post/publish/status/fetch/` - Check upload status

## 2. Authentication

### OAuth 2.0 Flow

TikTok uses OAuth 2.0 with PKCE (Proof Key Code Exchange) for user authorization:

1. Redirect user to TikTok authorization URL
2. User grants permissions (scopes)
3. Receive authorization code via callback
4. Exchange code for access token
5. Use access token with Bearer authentication

### Token Lifecycle

| Token Type | Validity | Refresh |
|------------|----------|---------|
| Access Token | 24 hours (86400 seconds) | Via refresh token |
| Refresh Token | 1 year (31536000 seconds) | Must re-authorize |

### Required Scopes

| Operation | Scope | Description |
|-----------|-------|-------------|
| Read profile | `user.info.basic` | Profile info (avatar, display name) |
| Read videos | `video.list` | Access to user's public videos |
| Upload draft | `video.upload` | Upload video to user's drafts |
| Direct post | `video.publish` | Post directly to user's profile |

## 3. App Approval Process

### Initial Registration

1. Create account on [TikTok for Developers](https://developers.tiktok.com/)
2. Create new app with project details
3. Add required products (Login Kit, Content Posting API, etc.)
4. Submit for review (3-14 days)

### 2025 Tightened Requirements

TikTok significantly increased approval scrutiny in 2025:
- More detailed application forms required
- UX mockups and integration reasoning needed
- Business/research affiliation often expected
- Geographic eligibility verification

### Audit Requirements for Publishing

**Unaudited Client Limitations:**
- Maximum 5 users can post in 24-hour window
- All posting accounts must be set to private
- Content visibility restricted to "Only You" (SELF_ONLY)
- No Direct Post functionality

**Audit Process:**
- Submit app for compliance review
- Demonstrate adherence to TikTok Terms of Service
- Provide demo accounts/capabilities as requested
- Ongoing monitoring and compliance audits possible

### Red Flag for agentio

From TikTok's developer guidelines:
> "API Clients must not be limited to test applications and should be intended for a wide audience, not limited to internal groups/private use."
>
> "Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages."

This explicitly excludes personal CLI tools like agentio from approval.

## 4. Rate Limits

### Content Posting API
- 6 requests per minute per user access token
- 2 videos per minute publishing limit
- 20 video posts per day maximum

### Display API
- Standard rate limits apply per endpoint
- HTTP 429 returned when exceeded
- One-minute sliding window

### Research API (if applicable)
- 1,000 requests per day
- 100,000 records per day maximum
- Resets at 12 AM UTC

## 5. Technical Requirements

### Video Upload Specifications

| Requirement | Specification |
|-------------|---------------|
| Max file size | 50 MB |
| Min duration | 3 seconds |
| Max duration | 60 seconds |
| Format | MP4 |
| Min resolution | 540p |

### OAuth Redirect Requirements

- HTTPS required (no localhost)
- Maximum 10 redirect URIs
- URI max length: 512 characters
- Static URIs only (no parameters)
- Domain verification required for URL-based video uploads

### Development/Testing

- Use NGROK or similar for local HTTPS testing
- Sandbox mode available (up to 5 sandboxes, 10 test accounts each)
- Direct Post not available in sandbox mode

## 6. Geographic Restrictions

### API Availability

TikTok API access requires developer to be in an approved country. Many countries have full or partial TikTok restrictions:

**Banned/Restricted (2025):**
- India (full ban)
- Afghanistan (full ban)
- Nepal (full ban)
- Albania (full ban)
- Canada (government device ban)
- United States (temporary suspension, currently operational)
- China (only Douyin available, not TikTok)

### Commercial Content API Coverage

Limited to specific regions including:
- Asia Pacific (Japan, Korea, SE Asia, Australia/NZ)
- Americas (US, Canada, Brazil, Mexico, etc.)
- EMEA (selected countries)

## 7. Pricing

### Official API

- **Free** for approved developers
- No per-request charges
- Subject to rate limits

### Third-Party Alternatives (if official access denied)

| Provider | Starting Price | Notes |
|----------|----------------|-------|
| SocialKit | $13/month | 2,000 credits |
| Ensembledata | $100/month | Limited features |
| Phyllo | Contact sales | Unified API |

## 8. Feasibility Assessment

### Pros

1. **Official API exists** - TikTok has a documented, supported API
2. **OAuth 2.0** - Standard authentication aligns with agentio patterns
3. **Free tier** - No API costs for approved apps
4. **Comprehensive endpoints** - Read and write operations available

### Cons / Critical Blockers

1. **Personal tool exclusion** - TikTok explicitly rejects "utility tools for managing your own accounts"
2. **Business affiliation expected** - Individual developers without business entity face higher rejection rates
3. **Audit requirement for publishing** - Direct posting requires additional audit approval
4. **No localhost development** - HTTPS with public domain required
5. **Strict rate limits** - 6 req/min per user, 20 posts/day max
6. **Video-only platform** - No text-only posting capability
7. **Geographic restrictions** - Access dependent on developer location
8. **2025 restrictions** - Approval process became significantly harder

### Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| App rejection | High | Very High | None - policy explicitly excludes personal tools |
| Audit failure | High | High | Cannot mitigate for personal CLI tool |
| Account suspension | High | Medium | Strict compliance |
| API deprecation | Medium | Low | Monitor announcements |
| Rate limit issues | Medium | Medium | Implement backoff |

## 9. Recommendation

### **NOT RECOMMENDED FOR IMPLEMENTATION**

TikTok's developer policies explicitly exclude the agentio use case:

> "Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages."

This makes approval highly unlikely. Even if somehow approved:

1. **Unaudited status** would limit functionality to private posts only
2. **Audit process** would fail since the tool is for personal/internal use
3. **Video-only nature** doesn't align with agentio's message-focused services
4. **HTTPS requirement** complicates CLI tool development

### Alternative Approaches

If TikTok integration is still desired:

1. **Use a third-party aggregator API** (SocialKit, Ensembledata) - adds cost but bypasses approval
2. **Browser automation** - technically possible but against ToS
3. **Wait for policy changes** - TikTok may relax restrictions in future
4. **Focus on Business API** - if user has registered TikTok business account

### Comparison with Existing Services

| Service | Approval | Personal Use | Text Support |
|---------|----------|--------------|--------------|
| Gmail | Easy (embedded OAuth) | Yes | Yes |
| Telegram | Trivial (Bot API) | Yes | Yes |
| TikTok | Very Hard | **No** | No |

## 10. Sources

- [TikTok for Developers](https://developers.tiktok.com/)
- [Content Posting API](https://developers.tiktok.com/products/content-posting-api/)
- [Display API Overview](https://developers.tiktok.com/doc/display-api-overview)
- [Developer Guidelines](https://developers.tiktok.com/doc/our-guidelines-developer-guidelines)
- [OAuth Token Management](https://developers.tiktok.com/doc/oauth-user-access-token-management)
- [Scopes Overview](https://developers.tiktok.com/doc/scopes-overview)
- [Rate Limits](https://developers.tiktok.com/doc/tiktok-api-v2-rate-limit)
- [Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines)
- [Sandbox Mode Introduction](https://developers.tiktok.com/blog/introducing-sandbox)
- [TikTok API Public Access 2025](https://www.echotik.live/blog/is-tiktoks-api-public-access-approval-process-2025/)
