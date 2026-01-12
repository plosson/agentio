# RSS Feed Integration Analysis

**Date:** January 2026
**Status:** HIGHLY RECOMMENDED

## Executive Summary

RSS (Really Simple Syndication) integration is an excellent fit for agentio. Unlike social media APIs, RSS feeds are:
- **Public** - No authentication required
- **Standardized** - Well-defined XML formats (RSS 2.0, Atom, RDF)
- **Free** - No API costs or rate limits
- **Read-only** - Focused on content consumption

This makes RSS one of the simplest integrations to implement while providing high value for LLM agents that need to consume web content.

## API Overview

### Feed Formats Supported

| Format | Description | Common Use |
|--------|-------------|------------|
| RSS 2.0 | Most common, XML-based | Blogs, news sites |
| Atom | More modern, XML-based | Google services, modern blogs |
| RDF | Older format | Legacy feeds |
| JSON Feed | Modern JSON-based | Developer blogs |

### No Authentication Required

RSS feeds are designed for public consumption. The "profile" concept in agentio would store:
- Feed URL
- Optional display name
- Optional category/tag

No OAuth, API keys, or tokens needed.

## Capabilities for agentio

### Read Operations

| Operation | Description | Implementation |
|-----------|-------------|----------------|
| `list` | List articles from a feed | Fetch and parse feed XML |
| `get` | Get full article content | Fetch feed, find by ID/GUID |
| `search` | Search across saved feeds | Parse multiple feeds, filter |

### Profile Management

Instead of credentials, profiles store feed configurations:

```typescript
interface RssProfile {
  url: string;           // Feed URL
  name?: string;         // Display name
  category?: string;     // Optional grouping
  lastFetched?: number;  // Cache timestamp
}
```

### Proposed Commands

```bash
# Feed management
agentio rss add <url> [--name <name>] [--profile <name>]
agentio rss list                           # List configured feeds
agentio rss remove --profile <name>

# Article operations
agentio rss articles [--profile <name>] [--limit N] [--since <date>]
agentio rss get <article-id> [--profile <name>]
agentio rss search --query <text> [--profile <name>]

# Multi-feed operations
agentio rss all [--limit N]                # Articles from all feeds
```

## Technical Implementation

### Recommended Library: rss-parser

[rss-parser](https://www.npmjs.com/package/rss-parser) is the most popular choice:
- 2M+ weekly downloads
- TypeScript support built-in
- Handles RSS 2.0, Atom, and RDF
- Works with custom fields
- Promise-based API

```typescript
import Parser from 'rss-parser';

const parser = new Parser();
const feed = await parser.parseURL('https://example.com/feed.xml');

console.log(feed.title);
for (const item of feed.items) {
  console.log(item.title, item.link, item.pubDate);
}
```

### Alternative: Feedsmith

[Feedsmith](https://github.com/macieklamberski/feedsmith) is a newer option:
- TypeScript-first
- Supports JSON Feed format
- OPML import/export
- Tree-shakable

### No External Dependencies Option

Could also use native fetch + a lightweight XML parser, but rss-parser handles edge cases and malformed feeds gracefully.

## Architecture Differences from Other Services

| Aspect | Other Services | RSS |
|--------|----------------|-----|
| Authentication | OAuth/API keys | None |
| Credentials storage | Encrypted tokens | Plain feed URLs |
| Profile = | Account access | Feed subscription |
| Rate limits | Platform-imposed | None (be polite) |
| Write operations | Yes | No (read-only) |

### Profile Storage

Since no secrets are involved, RSS profiles could be stored in plain config:

```json
{
  "profiles": {
    "rss": ["tech-news", "dev-blog", "company-updates"]
  },
  "rss": {
    "tech-news": {
      "url": "https://news.ycombinator.com/rss",
      "name": "Hacker News"
    },
    "dev-blog": {
      "url": "https://blog.example.com/feed.xml",
      "name": "Dev Blog"
    }
  }
}
```

## Rate Limiting Considerations

While RSS has no official rate limits, best practices:
- Cache feeds locally (refresh every 15-30 min)
- Respect `ttl` element if present in feed
- Use conditional GET (If-Modified-Since header)
- Don't hammer feeds on every command

## Feasibility Assessment

### Pros

1. **No authentication** - Simplest integration possible
2. **No API costs** - Completely free
3. **No rate limits** - Within reason
4. **Standardized format** - Well-supported libraries
5. **High value** - LLM agents can consume news, blogs, updates
6. **Offline-friendly** - Can cache feeds locally

### Cons / Limitations

1. **Read-only** - Cannot post to RSS feeds
2. **Full content varies** - Some feeds only include summaries
3. **No real-time** - Polling-based, not push
4. **Inconsistent quality** - Some feeds are malformed

### Risk Matrix

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Malformed feed | Low | Medium | rss-parser handles gracefully |
| Feed URL changes | Low | Low | User re-adds feed |
| CORS issues | N/A | N/A | CLI tool, not browser |
| Feed removed | Low | Low | Clear error message |

## Recommendation: IMPLEMENT

**Priority: HIGH** - This should be one of the easiest and most valuable integrations.

### Implementation Estimate

| Phase | Effort |
|-------|--------|
| Types | 15 min |
| Client | 30 min |
| Commands | 45 min |
| Output | 20 min |
| Testing | 30 min |
| **Total** | **~2.5 hours** |

### Comparison with Other Services

| Service | Auth Complexity | Implementation Time | Value |
|---------|-----------------|---------------------|-------|
| RSS | None | 2.5 hours | High |
| Discord | Low (token) | 3 hours | High |
| Confluence | Medium (OAuth) | 16-20 hours | Medium |
| Twitter | High (OAuth + $) | 8-12 hours | Medium |

## Sources

- [rss-parser - npm](https://www.npmjs.com/package/rss-parser)
- [Feedsmith - GitHub](https://github.com/macieklamberski/feedsmith)
- [@rowanmanning/feed-parser](https://github.com/rowanmanning/feed-parser)
- [Building an RSS Feed Reader with TypeScript](https://www.timsanteford.com/posts/building-an-rss-feed-reader-with-typescript-and-axios/)
