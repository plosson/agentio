# RSS Integration - Implementation Tasks

Following the project's service development guidelines.

**Estimated Total:** ~2.5 hours

---

## Phase 1: Foundation

### Task 1.1: Add Service Name to Config
**File:** `src/types/config.ts`

Add `'rss'` to the `ServiceName` union type.

```typescript
export type ServiceName = 'gmail' | 'telegram' | ... | 'rss';
```

**Effort:** 5 minutes

---

### Task 1.2: Create RSS Types
**File:** `src/types/rss.ts` (new file)

```typescript
/**
 * RSS feed configuration (stored in config, not encrypted)
 * No credentials needed - RSS feeds are public
 */
export interface RssFeedConfig {
  url: string;
  name?: string;
  category?: string;
  lastFetched?: number;
}

/**
 * Parsed feed metadata
 */
export interface RssFeed {
  title: string;
  description?: string;
  link?: string;
  language?: string;
  lastBuildDate?: string;
  items: RssArticle[];
}

/**
 * Individual article/item from feed
 */
export interface RssArticle {
  id: string;              // GUID or link as fallback
  title: string;
  link?: string;
  description?: string;    // Summary or full content
  content?: string;        // Full content if available
  author?: string;
  pubDate?: string;
  categories?: string[];
}

/**
 * Options for listing articles
 */
export interface RssListOptions {
  limit?: number;          // Max articles to return (default 20)
  since?: Date;            // Only articles after this date
}

/**
 * Options for searching across feeds
 */
export interface RssSearchOptions {
  query: string;           // Text to search for
  limit?: number;
  feeds?: string[];        // Specific feed profiles to search
}
```

**Effort:** 15 minutes

---

## Phase 2: API Client

### Task 2.1: Install rss-parser
**Command:**

```bash
bun add rss-parser
```

**Effort:** 2 minutes

---

### Task 2.2: Create RSS Client
**File:** `src/services/rss/client.ts` (new file)

```typescript
import Parser from 'rss-parser';
import type { RssFeed, RssArticle, RssFeedConfig, RssListOptions } from '../../types/rss';
import { CliError } from '../../utils/errors';

export class RssClient {
  private parser: Parser;
  private config: RssFeedConfig;

  constructor(config: RssFeedConfig) {
    this.config = config;
    this.parser = new Parser({
      customFields: {
        item: ['content:encoded', 'dc:creator'],
      },
    });
  }

  /**
   * Fetch and parse the RSS feed
   */
  async getFeed(): Promise<RssFeed> {
    try {
      const feed = await this.parser.parseURL(this.config.url);
      return this.parseFeed(feed);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
          throw new CliError('NETWORK_ERROR', `Cannot reach feed: ${this.config.url}`, 'Check the URL and your internet connection');
        }
        if (error.message.includes('Non-whitespace before first tag')) {
          throw new CliError('INVALID_PARAMS', 'Invalid RSS feed format', 'The URL may not be an RSS feed');
        }
      }
      throw new CliError('API_ERROR', `Failed to parse feed: ${error}`, 'Verify the feed URL is valid');
    }
  }

  /**
   * Get articles from the feed
   */
  async list(options?: RssListOptions): Promise<RssArticle[]> {
    const feed = await this.getFeed();
    let articles = feed.items;

    // Filter by date if specified
    if (options?.since) {
      articles = articles.filter(article => {
        if (!article.pubDate) return true;
        return new Date(article.pubDate) >= options.since!;
      });
    }

    // Apply limit
    const limit = options?.limit ?? 20;
    return articles.slice(0, limit);
  }

  /**
   * Get a specific article by ID
   */
  async get(articleId: string): Promise<RssArticle> {
    const feed = await this.getFeed();
    const article = feed.items.find(item => item.id === articleId || item.link === articleId);

    if (!article) {
      throw new CliError('NOT_FOUND', `Article not found: ${articleId}`, 'Use "agentio rss articles" to list available articles');
    }

    return article;
  }

  /**
   * Validate that the feed URL is accessible
   */
  async validate(): Promise<{ title: string; itemCount: number }> {
    const feed = await this.getFeed();
    return {
      title: feed.title,
      itemCount: feed.items.length,
    };
  }

  private parseFeed(raw: Parser.Output<Record<string, unknown>>): RssFeed {
    return {
      title: raw.title || 'Untitled Feed',
      description: raw.description,
      link: raw.link,
      language: raw.language,
      lastBuildDate: raw.lastBuildDate,
      items: raw.items.map(item => this.parseArticle(item)),
    };
  }

  private parseArticle(raw: Parser.Item): RssArticle {
    return {
      id: raw.guid || raw.link || raw.title || '',
      title: raw.title || 'Untitled',
      link: raw.link,
      description: raw.contentSnippet || raw.content,
      content: (raw as Record<string, unknown>)['content:encoded'] as string || raw.content,
      author: raw.creator || (raw as Record<string, unknown>)['dc:creator'] as string,
      pubDate: raw.pubDate || raw.isoDate,
      categories: raw.categories,
    };
  }
}
```

**Effort:** 30 minutes

---

## Phase 3: Commands

### Task 3.1: Create RSS Commands
**File:** `src/commands/rss.ts` (new file)

```typescript
import { Command } from 'commander';
import { RssClient } from '../services/rss/client';
import { CliError, handleError } from '../utils/errors';
import { getConfig, saveConfig, type Config } from '../config/config-manager';
import {
  printRssFeedList,
  printRssArticleList,
  printRssArticle,
  printRssFeedInfo,
} from '../utils/output';
import type { RssFeedConfig } from '../types/rss';

// Helper to get feed config from profile name
async function getRssFeedConfig(profileName?: string): Promise<{ config: RssFeedConfig; profile: string }> {
  const appConfig = await getConfig();

  // Get profile name (use default if not specified)
  const profile = profileName || appConfig.defaults?.rss;
  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      'No RSS feed configured',
      'Run: agentio rss add <url>'
    );
  }

  // Get feed config
  const feedConfig = (appConfig as Record<string, unknown>).rss?.[profile] as RssFeedConfig | undefined;
  if (!feedConfig) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      `Feed not found: ${profile}`,
      'Run: agentio rss list to see available feeds'
    );
  }

  return { config: feedConfig, profile };
}

export function registerRssCommands(program: Command): void {
  const rss = program
    .command('rss')
    .description('RSS feed operations');

  // Add a new feed
  rss
    .command('add')
    .description('Add an RSS feed')
    .argument('<url>', 'Feed URL')
    .option('--name <name>', 'Display name for the feed')
    .option('--profile <profile>', 'Profile name (defaults to feed title)')
    .action(async (url, options) => {
      try {
        // Validate the feed
        const tempConfig: RssFeedConfig = { url, name: options.name };
        const client = new RssClient(tempConfig);
        console.error(`Validating feed: ${url}`);
        const info = await client.validate();

        // Determine profile name
        const profileName = options.profile ||
          info.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);

        // Save to config
        const appConfig = await getConfig();
        if (!appConfig.profiles.rss) {
          appConfig.profiles.rss = [];
        }
        if (!(appConfig as Record<string, unknown>).rss) {
          (appConfig as Record<string, unknown>).rss = {};
        }

        // Check if already exists
        if (appConfig.profiles.rss.includes(profileName)) {
          throw new CliError('INVALID_PARAMS', `Feed already exists: ${profileName}`, 'Use a different --profile name');
        }

        appConfig.profiles.rss.push(profileName);
        (appConfig as Record<string, unknown>).rss[profileName] = {
          url,
          name: options.name || info.title,
        };

        // Set as default if first feed
        if (!appConfig.defaults?.rss) {
          if (!appConfig.defaults) appConfig.defaults = {};
          appConfig.defaults.rss = profileName;
        }

        await saveConfig(appConfig);

        console.log(`Feed added successfully!`);
        console.log(`  Profile: ${profileName}`);
        console.log(`  Title: ${info.title}`);
        console.log(`  Articles: ${info.itemCount}`);
      } catch (error) {
        handleError(error);
      }
    });

  // List configured feeds
  rss
    .command('list')
    .description('List configured RSS feeds')
    .action(async () => {
      try {
        const appConfig = await getConfig();
        const feeds = appConfig.profiles.rss || [];
        const rssConfigs = (appConfig as Record<string, unknown>).rss as Record<string, RssFeedConfig> || {};
        const defaultFeed = appConfig.defaults?.rss;

        printRssFeedList(feeds, rssConfigs, defaultFeed);
      } catch (error) {
        handleError(error);
      }
    });

  // Remove a feed
  rss
    .command('remove')
    .description('Remove an RSS feed')
    .requiredOption('--profile <name>', 'Profile name to remove')
    .action(async (options) => {
      try {
        const appConfig = await getConfig();
        const feeds = appConfig.profiles.rss || [];

        if (!feeds.includes(options.profile)) {
          throw new CliError('PROFILE_NOT_FOUND', `Feed not found: ${options.profile}`);
        }

        // Remove from profiles
        appConfig.profiles.rss = feeds.filter(f => f !== options.profile);

        // Remove config
        const rssConfigs = (appConfig as Record<string, unknown>).rss as Record<string, RssFeedConfig>;
        delete rssConfigs[options.profile];

        // Update default if needed
        if (appConfig.defaults?.rss === options.profile) {
          appConfig.defaults.rss = appConfig.profiles.rss[0];
        }

        await saveConfig(appConfig);
        console.log(`Feed removed: ${options.profile}`);
      } catch (error) {
        handleError(error);
      }
    });

  // Get articles from a feed
  rss
    .command('articles')
    .description('List articles from a feed')
    .option('--profile <name>', 'Feed profile name')
    .option('--limit <n>', 'Number of articles', '20')
    .option('--since <date>', 'Only articles after this date (YYYY-MM-DD)')
    .action(async (options) => {
      try {
        const { config, profile } = await getRssFeedConfig(options.profile);
        const client = new RssClient(config);

        const listOptions = {
          limit: parseInt(options.limit, 10),
          since: options.since ? new Date(options.since) : undefined,
        };

        const articles = await client.list(listOptions);
        printRssArticleList(articles, config.name || profile);
      } catch (error) {
        handleError(error);
      }
    });

  // Get a specific article
  rss
    .command('get')
    .description('Get a specific article')
    .argument('<article-id>', 'Article ID or URL')
    .option('--profile <name>', 'Feed profile name')
    .action(async (articleId, options) => {
      try {
        const { config } = await getRssFeedConfig(options.profile);
        const client = new RssClient(config);

        const article = await client.get(articleId);
        printRssArticle(article);
      } catch (error) {
        handleError(error);
      }
    });

  // Get feed info
  rss
    .command('info')
    .description('Get feed information')
    .option('--profile <name>', 'Feed profile name')
    .action(async (options) => {
      try {
        const { config, profile } = await getRssFeedConfig(options.profile);
        const client = new RssClient(config);

        const feed = await client.getFeed();
        printRssFeedInfo(feed, profile);
      } catch (error) {
        handleError(error);
      }
    });
}
```

**Effort:** 45 minutes

---

## Phase 4: Output Formatting

### Task 4.1: Add RSS Output Formatters
**File:** `src/utils/output.ts` (add to existing)

```typescript
import type { RssFeed, RssArticle, RssFeedConfig } from '../types/rss';

export function printRssFeedList(
  profiles: string[],
  configs: Record<string, RssFeedConfig>,
  defaultProfile?: string
): void {
  if (profiles.length === 0) {
    console.log('No RSS feeds configured');
    console.log('Add a feed with: agentio rss add <url>');
    return;
  }

  console.log(`RSS Feeds (${profiles.length}):\n`);
  for (const profile of profiles) {
    const config = configs[profile];
    const isDefault = profile === defaultProfile;
    const marker = isDefault ? ' (default)' : '';
    console.log(`  ${profile}${marker}`);
    console.log(`    Name: ${config?.name || 'N/A'}`);
    console.log(`    URL: ${config?.url || 'N/A'}`);
    console.log('');
  }
}

export function printRssArticleList(articles: RssArticle[], feedName: string): void {
  if (articles.length === 0) {
    console.log('No articles found');
    return;
  }

  console.log(`Articles from ${feedName} (${articles.length}):\n`);
  for (const article of articles) {
    const date = article.pubDate ? new Date(article.pubDate).toLocaleDateString() : 'N/A';
    console.log(`[${article.id.slice(0, 40)}]`);
    console.log(`  Title: ${article.title}`);
    console.log(`  Date: ${date}`);
    if (article.author) {
      console.log(`  Author: ${article.author}`);
    }
    if (article.link) {
      console.log(`  Link: ${article.link}`);
    }
    console.log('');
  }
}

export function printRssArticle(article: RssArticle): void {
  console.log(`Title: ${article.title}`);
  console.log(`ID: ${article.id}`);
  if (article.author) {
    console.log(`Author: ${article.author}`);
  }
  if (article.pubDate) {
    console.log(`Published: ${new Date(article.pubDate).toLocaleString()}`);
  }
  if (article.link) {
    console.log(`Link: ${article.link}`);
  }
  if (article.categories?.length) {
    console.log(`Categories: ${article.categories.join(', ')}`);
  }
  console.log('');
  console.log('--- Content ---');
  console.log(article.content || article.description || 'No content available');
}

export function printRssFeedInfo(feed: RssFeed, profile: string): void {
  console.log(`Feed: ${profile}`);
  console.log(`Title: ${feed.title}`);
  if (feed.description) {
    console.log(`Description: ${feed.description}`);
  }
  if (feed.link) {
    console.log(`Link: ${feed.link}`);
  }
  if (feed.language) {
    console.log(`Language: ${feed.language}`);
  }
  if (feed.lastBuildDate) {
    console.log(`Last Updated: ${feed.lastBuildDate}`);
  }
  console.log(`Articles: ${feed.items.length}`);
}
```

**Effort:** 20 minutes

---

## Phase 5: Integration

### Task 5.1: Register Commands
**File:** `src/index.ts`

```typescript
import { registerRssCommands } from './commands/rss';

// In registration section:
registerRssCommands(program);
```

**Effort:** 5 minutes

---

## Phase 6: Testing

### Task 6.1: Manual Testing Checklist

**Feed Management:**
- [ ] `agentio rss add https://news.ycombinator.com/rss` - Adds HN feed
- [ ] `agentio rss add https://blog.example.com/feed.xml --name "My Blog"` - Custom name
- [ ] `agentio rss list` - Shows configured feeds
- [ ] `agentio rss remove --profile hacker-news` - Removes feed

**Article Operations:**
- [ ] `agentio rss articles` - Lists articles from default feed
- [ ] `agentio rss articles --limit 5` - Limits results
- [ ] `agentio rss articles --since 2026-01-01` - Date filter
- [ ] `agentio rss get <id>` - Gets specific article
- [ ] `agentio rss info` - Shows feed metadata

**Error Handling:**
- [ ] Invalid URL returns helpful error
- [ ] Non-RSS URL returns appropriate error
- [ ] Missing profile returns suggestion to add feed
- [ ] Network error handled gracefully

**Effort:** 30 minutes

---

## Summary

| Phase | Tasks | Effort |
|-------|-------|--------|
| Phase 1 | Types | 20 min |
| Phase 2 | Client | 32 min |
| Phase 3 | Commands | 45 min |
| Phase 4 | Output | 20 min |
| Phase 5 | Integration | 5 min |
| Phase 6 | Testing | 30 min |
| **Total** | | **~2.5 hours** |

---

## File Checklist

- [ ] `src/types/config.ts` - Add 'rss' to ServiceName
- [ ] `src/types/rss.ts` - Create type definitions
- [ ] `src/services/rss/client.ts` - Create RssClient
- [ ] `src/commands/rss.ts` - Create CLI commands
- [ ] `src/utils/output.ts` - Add RSS formatters
- [ ] `src/index.ts` - Register commands
- [ ] `bun add rss-parser` - Install dependency

---

## Notes

### Config Storage

RSS feeds don't need encrypted storage since they're public URLs. Store in plain config alongside profiles:

```json
{
  "profiles": {
    "rss": ["hacker-news", "dev-blog"]
  },
  "defaults": {
    "rss": "hacker-news"
  },
  "rss": {
    "hacker-news": {
      "url": "https://news.ycombinator.com/rss",
      "name": "Hacker News"
    }
  }
}
```

### Future Enhancements

1. **OPML import/export** - Import feeds from other readers
2. **Feed categories** - Group feeds by topic
3. **Local caching** - Store fetched articles locally
4. **Search across feeds** - Search all configured feeds at once
5. **Mark as read** - Track which articles have been read
