import type { RssArticle, RssFeed } from './types';

export function printRssArticleList(articles: RssArticle[], feedName: string): void {
  if (articles.length === 0) {
    console.log('No articles found');
    return;
  }

  console.log(`Articles from ${feedName} (${articles.length})\n`);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(`[${i + 1}] ${article.title}`);
    if (article.author) console.log(`    Author: ${article.author}`);
    if (article.pubDate) console.log(`    Date: ${article.pubDate}`);
    if (article.link) console.log(`    Link: ${article.link}`);
    if (article.description) {
      const snippet = article.description.length > 150
        ? article.description.substring(0, 150) + '...'
        : article.description;
      console.log(`    > ${snippet}`);
    }
    console.log('');
  }
}

export function printRssArticle(article: RssArticle): void {
  console.log(`Title: ${article.title}`);
  if (article.author) console.log(`Author: ${article.author}`);
  if (article.pubDate) console.log(`Date: ${article.pubDate}`);
  if (article.link) console.log(`Link: ${article.link}`);
  if (article.categories && article.categories.length > 0) {
    console.log(`Categories: ${article.categories.join(', ')}`);
  }
  console.log('---');
  console.log(article.content || article.description || 'No content available');
}

export function printRssFeedInfo(feed: RssFeed & { feedUrl: string }): void {
  console.log(`Title: ${feed.title}`);
  console.log(`Feed URL: ${feed.feedUrl}`);
  if (feed.description) console.log(`Description: ${feed.description}`);
  if (feed.link) console.log(`Site: ${feed.link}`);
  if (feed.language) console.log(`Language: ${feed.language}`);
  if (feed.lastBuildDate) console.log(`Last Updated: ${feed.lastBuildDate}`);
  console.log(`Articles: ${feed.items.length}`);
}
