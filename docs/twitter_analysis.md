# Twitter/X API Integration Analysis for agentio

**Date:** January 2026
**Author:** Claude (AI Assistant)

## Executive Summary

The X (formerly Twitter) API can technically support the functionality needed for agentio (posting tweets, reading timelines). However, **the current pricing model makes implementation impractical for a general-purpose CLI tool** unless users are willing to pay $200+/month for the Basic tier.

**Recommendation:** Implement with caution. The Free tier is too restrictive for practical use, and the paid tiers are expensive. Implementation should clearly communicate cost expectations to users.

---

## 1. API Capabilities Overview

### Available Endpoints (X API v2)

| Operation | Endpoint | Auth Required | Free Tier |
|-----------|----------|---------------|-----------|
| Post Tweet | `POST /2/tweets` | OAuth 2.0 or OAuth 1.0a | Yes (1,500/month) |
| Get User Timeline | `GET /2/users/{id}/tweets` | OAuth 2.0 or Bearer | Limited (1 req/24h) |
| Get Home Timeline | `GET /2/users/{id}/reverse_chronological_timeline` | OAuth 2.0 | Not available |
| Get Tweet by ID | `GET /2/tweets/{id}` | OAuth 2.0 or Bearer | Limited |
| Delete Tweet | `DELETE /2/tweets/{id}` | OAuth 2.0 or OAuth 1.0a | Yes |
| Search Tweets | `GET /2/tweets/search/recent` | OAuth 2.0 or Bearer | Not available |

### Key Limitations

- **Free Tier:** Write-only focus (1,500 posts/month), read access is essentially unusable (1 request per 24 hours)
- **Home Timeline:** Only available on Basic tier and above
- **Search:** Not available on Free tier
- **Media uploads:** Require OAuth 1.0a for full functionality

---

## 2. Authentication Requirements

### Supported Methods

1. **OAuth 2.0 Authorization Code Flow with PKCE** (Recommended)
   - Modern, secure approach
   - Fine-grained scopes
   - Supports refresh tokens with `offline.access` scope

2. **OAuth 1.0a** (Legacy but still supported)
   - Required for media uploads with tweets
   - Simpler for server-side applications

3. **Bearer Token (App-Only)**
   - For public data access only
   - No user context

### Required Scopes for agentio

| Scope | Purpose |
|-------|---------|
| `tweet.read` | Read tweets and timelines |
| `tweet.write` | Post and delete tweets |
| `users.read` | Get user information |
| `offline.access` | Enable refresh tokens |

### OAuth App Registration

**Can a third-party app like agentio get OAuth credentials?** Yes.

Process:
1. Sign up at [developer.x.com](https://developer.x.com)
2. Verify email and phone number
3. Apply for developer account (describe use case)
4. Create a Project and App
5. Enable OAuth 2.0 in app settings
6. Configure callback URL
7. Generate Client ID and Client Secret

**Important:** Unlike Gmail, X does not allow embedding OAuth credentials in open-source apps. Each user must register their own developer app OR the agentio project would need to host a shared OAuth app (which incurs costs and approval requirements).

---

## 3. Pricing and Rate Limits

### Pricing Tiers (as of January 2026)

| Tier | Monthly Cost | Posts/Month | Reads/Month | Notes |
|------|-------------|-------------|-------------|-------|
| Free | $0 | 1,500 | ~30 (1/day) | Write-focused only |
| Basic | $200 | 50,000 | 15,000 | Minimum for practical use |
| Pro | $5,000 | 1,000,000 | 1,000,000 | Full API access |
| Enterprise | $42,000+ | 50,000,000+ | Custom | Dedicated support |

### Rate Limits

| Endpoint | Free Tier | Basic Tier |
|----------|-----------|------------|
| POST tweets | 1,500/month cap | 50,000/month |
| GET user timeline | 1 request/24h | 180 requests/15min |
| GET home timeline | Not available | 180 requests/15min |
| User lookup | 1 request/24h | 900 requests/15min |

### Recent Changes (2024-2025)

- **October 2024:** Basic tier increased from $100 to $200/month
- **Late 2025:** Pay-per-use pilot launched (closed beta, $500 voucher for testers)
- The pay-per-use model may become generally available in 2026

---

## 4. Feasibility Assessment

### Technical Feasibility: HIGH

The API provides all necessary endpoints for:
- Posting tweets
- Reading user timelines
- Reading home timeline (Basic+ tier)
- Deleting tweets

Implementation is straightforward using standard HTTP requests with OAuth 2.0.

### Practical Feasibility: MODERATE-LOW

| Factor | Assessment |
|--------|------------|
| **Free tier usability** | Very poor - reading is nearly unusable |
| **Cost for users** | High ($200/month minimum for practical use) |
| **OAuth complexity** | Moderate - users must create their own app |
| **API stability** | Moderate - frequent policy changes under Musk |
| **Third-party alternatives** | Several exist (twitterapi.io, etc.) but add costs |

### Comparison with Existing agentio Services

| Service | OAuth Credentials | Monthly Cost | Read + Write |
|---------|-------------------|--------------|--------------|
| Gmail | Embedded (free) | $0 | Yes |
| Telegram | User's bot token | $0 | Yes |
| Twitter/X | User must create | $0-200+ | Mostly write on free |

---

## 5. Risks and Limitations

### Major Risks

1. **Cost Barrier**
   - Free tier is nearly useless for reading tweets
   - $200/month is prohibitive for casual users
   - May limit adoption significantly

2. **Policy Volatility**
   - API policies have changed frequently since 2023
   - Prices have increased (Basic: $100 -> $200)
   - Future changes unpredictable

3. **OAuth Complexity**
   - Cannot embed OAuth credentials like Gmail
   - Each user must create their own X Developer app
   - More complex setup process

4. **Rate Limiting**
   - Even paid tiers have strict limits
   - No grace period for burst usage

### Minor Risks

- OAuth 1.0a still required for some media operations
- Two-hour token expiry without `offline.access` scope
- App permission changes require user re-authorization

---

## 6. Implementation Recommendation

### Recommended Approach

**Implement with clear limitations:**

1. **Implement Free tier features:**
   - `twitter send` - Post tweets (1,500/month limit)
   - `twitter delete` - Delete tweets
   - `twitter profile` - Profile management

2. **Implement Basic tier features (gated):**
   - `twitter list` - List user's tweets
   - `twitter timeline` - Home timeline
   - `twitter get` - Get specific tweet

3. **User Authentication:**
   - Require users to create their own X Developer app
   - Store: API Key, API Secret, Access Token, Access Token Secret (OAuth 1.0a)
   - OR: Client ID, Client Secret, Access Token, Refresh Token (OAuth 2.0)
   - Document the setup process clearly

4. **Clear Documentation:**
   - Explain pricing tiers upfront
   - Warn about Free tier limitations
   - Provide step-by-step developer app setup guide

### Alternative Approach: Skip Implementation

Given the cost barriers and complexity compared to Gmail/Telegram, it may be reasonable to skip Twitter/X integration entirely or defer until:
- Pay-per-use model becomes generally available
- Pricing becomes more developer-friendly
- A viable free/cheap alternative emerges

---

## 7. Sources

- [X API Guide 2025: Authentication, Endpoints & Pricing](https://getlate.dev/blog/x-api)
- [Twitter/X API Pricing 2025: Complete Cost Breakdown](https://getlate.dev/blog/twitter-api-pricing)
- [How to Get X API Key: Complete 2025 Guide](https://elfsight.com/blog/how-to-get-x-twitter-api-key-in-2025/)
- [X Developer Portal Overview](https://developer.twitter.com/en/docs/developer-portal/overview)
- [OAuth 2.0 Authorization Code Flow with PKCE](https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code)
- [X API Rate Limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X Updates API Pricing](https://www.socialmediatoday.com/news/x-formerly-twitter-launches-usage-based-api-access-charges/803315/)
- [Twitter API Free Tier Alternatives 2025](https://sociavault.com/blog/twitter-api-alternative-2025)
- [Announcing X API Pay-Per-Use Pricing Pilot](https://devcommunity.x.com/t/announcing-the-x-api-pay-per-use-pricing-pilot/250253)
