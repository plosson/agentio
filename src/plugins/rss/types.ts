export interface RssFeed {
  title: string;
  description?: string;
  link?: string;
  language?: string;
  lastBuildDate?: string;
  items: RssArticle[];
}

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

export interface RssListOptions {
  limit?: number;
  since?: Date;
}
