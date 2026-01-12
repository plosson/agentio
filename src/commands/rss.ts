import { Command } from 'commander';
import { RssClient } from '../services/rss/client';
import { handleError } from '../utils/errors';
import {
  printRssArticleList,
  printRssArticle,
  printRssFeedInfo,
} from '../utils/output';

export function registerRssCommands(program: Command): void {
  const rss = program
    .command('rss')
    .description('RSS feed operations');

  // Get articles from a feed
  rss
    .command('articles')
    .description('List articles from a blog')
    .argument('<url>', 'Blog URL (feed will be auto-discovered)')
    .option('--limit <n>', 'Number of articles', '20')
    .option('--since <date>', 'Only articles after this date (YYYY-MM-DD)')
    .action(async (url, options) => {
      try {
        const client = new RssClient();
        const listOptions = {
          limit: parseInt(options.limit, 10),
          since: options.since ? new Date(options.since) : undefined,
        };

        const info = await client.getInfo(url);
        const articles = await client.list(url, listOptions);
        printRssArticleList(articles, info.title);
      } catch (error) {
        handleError(error);
      }
    });

  // Get a specific article
  rss
    .command('get')
    .description('Get a specific article')
    .argument('<url>', 'Blog URL (feed will be auto-discovered)')
    .argument('<article-id>', 'Article ID or URL')
    .action(async (url, articleId) => {
      try {
        const client = new RssClient();
        const article = await client.get(url, articleId);
        printRssArticle(article);
      } catch (error) {
        handleError(error);
      }
    });

  // Get feed info
  rss
    .command('info')
    .description('Get feed information')
    .argument('<url>', 'Blog URL (feed will be auto-discovered)')
    .action(async (url) => {
      try {
        const client = new RssClient();
        const info = await client.getInfo(url);
        printRssFeedInfo(info);
      } catch (error) {
        handleError(error);
      }
    });
}
