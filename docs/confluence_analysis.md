# Confluence API Analysis for agentio CLI Integration

## Executive Summary

Confluence Cloud provides a robust REST API (v2) suitable for CLI integration. The API supports page/content management with OAuth 2.0 authentication, making it feasible to implement as a new service in agentio. Implementation is **recommended** with some considerations around OAuth complexity.

---

## 1. API Overview

### API Versions

| Version | Status | Base Path | Target Platform |
|---------|--------|-----------|-----------------|
| REST API v1 | Deprecated (EOL: Jan 2024) | `/wiki/rest/api` | Cloud/DC |
| REST API v2 | Current | `/wiki/api/v2` | Cloud |
| Data Center API | Maintained | `/rest/api` | Data Center only |

**Recommendation**: Use REST API v2 for Confluence Cloud. The v2 API offers:
- Better performance through endpoint specialization
- Cursor-based pagination (more efficient than v1's offset-based)
- Granular OAuth 2.0 scopes
- Cleaner content type separation

### Available Endpoints (v2)

| Category | Endpoints | Operations |
|----------|-----------|------------|
| Pages | `/wiki/api/v2/pages` | GET (list), POST (create) |
| Pages | `/wiki/api/v2/pages/{id}` | GET, PUT (update), DELETE |
| Pages by Space | `/wiki/api/v2/spaces/{id}/pages` | GET (list) |
| Blog Posts | `/wiki/api/v2/blogposts` | CRUD operations |
| Spaces | `/wiki/api/v2/spaces` | GET (list), GET by ID |
| Comments | `/wiki/api/v2/pages/{id}/footer-comments` | CRUD operations |
| Attachments | `/wiki/api/v2/pages/{id}/attachments` | CRUD operations |
| Labels | `/wiki/api/v2/pages/{id}/labels` | GET, POST, DELETE |
| Search | `/wiki/api/v2/search` | GET with CQL |

### Content Body Formats

The API supports multiple content representations:
- `storage` - Confluence storage format (XML-like)
- `atlas_doc_format` - Atlassian Document Format (JSON)
- `wiki` - Legacy wiki markup (limited support)

---

## 2. Authentication Methods

### Option A: API Tokens (Basic Auth)

**How it works**:
- User creates API token at https://id.atlassian.com/manage/api-tokens
- Requests use Basic Auth: `email:api_token` (base64 encoded)
- Tokens can have scopes (granular permissions)

**Pros**:
- Simple to implement
- User-friendly setup flow
- Scoped tokens available for security

**Cons**:
- Tokens expire (1 year max after March 2025)
- Tied to individual user account
- Not compliant with Atlassian's app policies for distribution

**Best for**: Personal use, scripts, internal tools

### Option B: OAuth 2.0 (3LO)

**How it works**:
1. Register app in Atlassian Developer Console
2. User authorizes via browser flow
3. App receives access + refresh tokens
4. Requests use Bearer token via `api.atlassian.com`

**Pros**:
- More secure (no password/token sharing)
- Refresh tokens for long-lived access
- Compliant with Atlassian security requirements
- Embedded credentials possible (like Gmail in agentio)

**Cons**:
- More complex implementation
- Requires browser-based authorization
- Different API base URL (`api.atlassian.com` vs `{site}.atlassian.net`)

**Best for**: Distributed tools, apps with multiple users

### Recommendation for agentio

**Primary**: OAuth 2.0 (3LO) with embedded client credentials
- Matches existing Gmail pattern
- More secure for end users
- Single app registration covers all users

**Fallback**: API Token support for users who prefer it
- Similar to how some services offer multiple auth options

---

## 3. OAuth 2.0 Scopes

### Required Scopes for agentio Operations

| Operation | Scope | Description |
|-----------|-------|-------------|
| Read pages | `read:page:confluence` | View page content |
| Create/update pages | `write:page:confluence` | Create and modify pages |
| Delete pages | `delete:page:confluence` | Move to trash/purge |
| Read spaces | `read:space:confluence` | List and view spaces |
| Search | `search:confluence` | Use CQL search |
| Read user | `read:me` | Get current user info |
| Offline access | `offline_access` | Refresh token support |

### Minimal Scope Set

```
read:page:confluence
write:page:confluence
read:space:confluence
search:confluence
read:me
offline_access
```

---

## 4. Rate Limits

### Points-Based System (Confluence Cloud)

| Tier | Quota | Notes |
|------|-------|-------|
| Tier 1 (Global) | 65,000 points/hour | Default for all apps |
| Tier 2 Free | 65,000 points/hour | Per-tenant |
| Tier 2 Standard | 100,000 + 10/user | Max 500,000 |
| Tier 2 Premium | 130,000 + 20/user | Max 500,000 |
| Tier 2 Enterprise | 150,000 + 30/user | Max 500,000 |

### Point Costs

- Read operations: 1-2 points
- Write operations: 1 point
- Complex queries: Higher cost

### Burst Limits

- Enforced independently from hourly quota
- Short time window (seconds)
- Reset quickly after violation

### Rate Limit Response

```
HTTP/1.1 429 Too Many Requests
Retry-After: 1847
X-RateLimit-Limit: 65000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2025-10-08T15:00:00Z
```

### Handling Strategy

1. Check `Retry-After` header on 429 responses
2. Implement exponential backoff with jitter
3. Track remaining quota via response headers

---

## 5. Cloud vs Data Center

| Aspect | Cloud | Data Center |
|--------|-------|-------------|
| API Version | v2 recommended | v1 style maintained |
| Authentication | OAuth 2.0 / API tokens | Basic auth / PAT |
| Base URL | `api.atlassian.com` (OAuth) | Self-hosted URL |
| Rate Limits | Points-based | Configurable |
| Support | Active development | Maintenance mode |
| End of Sale | N/A | March 2026 |

**Recommendation**: Focus on Cloud initially. Data Center support can be added later if needed, but market is shifting to Cloud.

---

## 6. Pricing Impact

Confluence API access is included with Confluence Cloud subscription:
- Free: Up to 10 users
- Standard: $5.16/user/month
- Premium: $9.73/user/month
- Enterprise: Contact sales

No additional API fees. Rate limits scale with plan tier.

---

## 7. Feasibility Assessment

### Technical Feasibility: **HIGH**

| Factor | Assessment |
|--------|------------|
| API Maturity | Stable v2 API with good documentation |
| Authentication | OAuth 2.0 matches existing Gmail pattern |
| Functionality | Covers read/write/search needs |
| Rate Limits | Generous for CLI use cases |

### Implementation Complexity: **MEDIUM**

| Component | Complexity | Notes |
|-----------|------------|-------|
| OAuth flow | Medium | Reuse existing oauth.ts patterns |
| API client | Low | Standard REST with cursor pagination |
| Content formatting | Medium | Storage format has learning curve |
| Multi-site support | Medium | Users may have multiple Confluence sites |

### Alignment with agentio Goals: **HIGH**

- Confluence is a common knowledge management tool
- LLM agents benefit from wiki access for context
- Complements existing Gmail/Telegram services

---

## 8. Risks and Limitations

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| OAuth complexity | Medium | Reuse Gmail OAuth patterns |
| Storage format learning curve | Low | Provide format conversion utilities |
| Multi-site handling | Medium | Design profile to include site selection |
| Rate limit changes (Feb 2026) | Low | Monitor Atlassian announcements |

### Limitations

1. **No real-time updates**: No webhook support in basic API (requires Connect/Forge apps)
2. **Content format**: Native format is XML-like storage format, not Markdown
3. **Permissions inheritance**: API respects user permissions - can't access restricted content
4. **Site-specific tokens**: OAuth tokens are scoped to specific Confluence sites

### API Quirks

1. **Parent pages**: v2 API removed `ancestor` parameter - need alternative approach for nested pages
2. **Editor version**: Creating pages compatible with "new editor" requires specific format
3. **Cursor pagination**: Different from offset-based - requires pagination helper

---

## 9. Recommendation

**RECOMMENDED FOR IMPLEMENTATION**

Confluence integration is a strong fit for agentio:

1. **Value**: High utility for LLM agents needing documentation access
2. **Feasibility**: Well-documented API with proven OAuth 2.0 patterns
3. **Alignment**: Matches existing multi-profile architecture
4. **Complexity**: Manageable - similar to Gmail implementation

### Suggested Scope (MVP)

| Command | Priority | Description |
|---------|----------|-------------|
| `confluence list` | P1 | List pages in a space |
| `confluence get` | P1 | Read page content |
| `confluence search` | P1 | Search across spaces |
| `confluence create` | P2 | Create new page |
| `confluence update` | P2 | Update existing page |
| `confluence profile add/list/remove` | P1 | Profile management |

### Next Steps

1. Create OAuth 2.0 app in Atlassian Developer Console
2. Implement types and client following service guidelines
3. Add OAuth flow with site selection
4. Build CLI commands

---

## Sources

- [Confluence Cloud REST API v2 Introduction](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [Confluence REST API v2 Page Endpoints](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
- [OAuth 2.0 (3LO) Apps](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)
- [Confluence Scopes for OAuth 2.0](https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/)
- [Rate Limiting](https://developer.atlassian.com/cloud/confluence/rate-limiting/)
- [Basic Auth for REST APIs](https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/)
- [Managing OAuth Apps](https://developer.atlassian.com/cloud/oauth/getting-started/managing-oauth-apps/)
- [Atlassian API Rate Limits Evolution](https://www.atlassian.com/blog/platform/evolving-api-rate-limits)
