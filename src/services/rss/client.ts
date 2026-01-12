import Parser from 'rss-parser';
import type { RssFeed, RssArticle, RssListOptions } from '../../types/rss';
import { CliError } from '../../utils/errors';

type CustomItem = {
  contentEncoded?: string;
  dcCreator?: string;
};

type CustomFeed = {
  language?: string;
  lastBuildDate?: string;
};

// Common feed paths to try if discovery fails
const COMMON_FEED_PATHS = [
  '/feed',
  '/feed.xml',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/index.xml',
  '/feed/atom',
  '/feed/rss',
];

export class RssClient {
  private parser: Parser<CustomFeed, CustomItem>;
  private feedUrl: string | null = null;

  constructor() {
    this.parser = new Parser({
      customFields: {
        item: [['content:encoded', 'contentEncoded'], ['dc:creator', 'dcCreator']],
      },
    });
  }

  /**
   * Discover RSS feed URL from a blog URL
   */
  async discoverFeed(url: string): Promise<string> {
    // Normalize URL
    let baseUrl = url.trim();
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      baseUrl = 'https://' + baseUrl;
    }
    baseUrl = baseUrl.replace(/\/$/, '');

    // First, try to parse the URL directly as a feed
    try {
      await this.parser.parseURL(baseUrl);
      this.feedUrl = baseUrl;
      return baseUrl;
    } catch {
      // Not a feed, continue with discovery
    }

    // Fetch the page and look for feed links in HTML
    try {
      const response = await fetch(baseUrl, {
        headers: { 'User-Agent': 'agentio-rss/1.0' },
      });

      if (response.ok) {
        const html = await response.text();
        const feedUrl = this.extractFeedUrl(html, baseUrl);
        if (feedUrl) {
          // Verify it's a valid feed
          try {
            await this.parser.parseURL(feedUrl);
            this.feedUrl = feedUrl;
            return feedUrl;
          } catch {
            // Invalid feed, continue trying
          }
        }
      }
    } catch {
      // Failed to fetch page, continue with common paths
    }

    // Try common feed paths
    for (const path of COMMON_FEED_PATHS) {
      const feedUrl = baseUrl + path;
      try {
        await this.parser.parseURL(feedUrl);
        this.feedUrl = feedUrl;
        return feedUrl;
      } catch {
        // Try next path
      }
    }

    throw new CliError(
      'NOT_FOUND',
      `Could not find RSS feed for: ${url}`,
      'Try providing the direct feed URL instead'
    );
  }

  /**
   * Extract feed URL from HTML link tags
   */
  private extractFeedUrl(html: string, baseUrl: string): string | null {
    // Match <link> tags with rel="alternate" and type containing rss or atom
    const linkRegex = /<link[^>]*rel=["']alternate["'][^>]*>/gi;
    const matches = html.match(linkRegex) || [];

    for (const link of matches) {
      // Check if it's an RSS or Atom feed
      if (link.includes('application/rss+xml') ||
          link.includes('application/atom+xml') ||
          link.includes('application/feed+json')) {
        // Extract href
        const hrefMatch = link.match(/href=["']([^"']+)["']/i);
        if (hrefMatch) {
          let href = hrefMatch[1];
          // Handle relative URLs
          if (href.startsWith('/')) {
            const urlObj = new URL(baseUrl);
            href = urlObj.origin + href;
          } else if (!href.startsWith('http')) {
            href = baseUrl + '/' + href;
          }
          return href;
        }
      }
    }

    return null;
  }

  /**
   * Fetch and parse the RSS feed
   */
  async getFeed(url?: string): Promise<RssFeed> {
    const feedUrl = url || this.feedUrl;
    if (!feedUrl) {
      throw new CliError('INVALID_PARAMS', 'No feed URL provided', 'Call discoverFeed() first or provide a URL');
    }

    try {
      const feed = await this.parser.parseURL(feedUrl);
      return this.parseFeed(feed);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof Error) {
        if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
          throw new CliError('NETWORK_ERROR', `Cannot reach feed: ${feedUrl}`, 'Check the URL and your internet connection');
        }
        if (error.message.includes('Non-whitespace before first tag') || error.message.includes('Invalid XML')) {
          throw new CliError('INVALID_PARAMS', 'Invalid RSS feed format', 'The URL may not be an RSS feed');
        }
      }
      throw new CliError('API_ERROR', `Failed to parse feed: ${error}`, 'Verify the feed URL is valid');
    }
  }

  /**
   * Get articles from the feed
   */
  async list(url: string, options?: RssListOptions): Promise<RssArticle[]> {
    const feedUrl = await this.discoverFeed(url);
    const feed = await this.getFeed(feedUrl);
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
  async get(url: string, articleId: string): Promise<RssArticle> {
    const feedUrl = await this.discoverFeed(url);
    const feed = await this.getFeed(feedUrl);
    const article = feed.items.find(item => item.id === articleId || item.link === articleId);

    if (!article) {
      throw new CliError('NOT_FOUND', `Article not found: ${articleId}`, 'Use "agentio rss articles" to list available articles');
    }

    return article;
  }

  /**
   * Get feed info
   */
  async getInfo(url: string): Promise<RssFeed & { feedUrl: string }> {
    const feedUrl = await this.discoverFeed(url);
    const feed = await this.getFeed(feedUrl);
    return { ...feed, feedUrl };
  }

  private parseFeed(raw: Parser.Output<CustomFeed & CustomItem>): RssFeed {
    // Cast to access optional feed properties not in base type
    const feedData = raw as Parser.Output<CustomFeed & CustomItem> & CustomFeed;
    return {
      title: raw.title || 'Untitled Feed',
      description: raw.description,
      link: raw.link,
      language: feedData.language,
      lastBuildDate: feedData.lastBuildDate,
      items: (raw.items || []).map(item => this.parseArticle(item)),
    };
  }

  private parseArticle(raw: Parser.Item & CustomItem): RssArticle {
    return {
      id: raw.guid || raw.link || raw.title || '',
      title: raw.title || 'Untitled',
      link: raw.link,
      description: raw.contentSnippet || raw.content,
      content: raw.contentEncoded || raw.content,
      author: raw.creator || raw.dcCreator,
      pubDate: raw.pubDate || raw.isoDate,
      categories: raw.categories,
    };
  }
}
