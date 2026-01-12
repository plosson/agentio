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
  id: string;
  title: string;
  link?: string;
  description?: string;
  content?: string;
  author?: string;
  pubDate?: string;
  categories?: string[];
}

/**
 * Options for listing articles
 */
export interface RssListOptions {
  limit?: number;
  since?: Date;
}
