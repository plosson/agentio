import { Command } from 'commander';
import { RssClient } from '../services/rss/client';
import { handleError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
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
  addExamples(
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
      }),
    `Examples:

  # 20 most recent articles (feed auto-discovered from blog URL)
  agentio rss articles https://simonwillison.net

  # cap to 5 articles
  agentio rss articles https://simonwillison.net --limit 5

  # only articles since a date
  agentio rss articles https://steipete.me --since 2026-01-01

  # direct feed URL also works
  agentio rss articles https://example.com/feed.xml --limit 10`,
  );

  // Get a specific article
  addExamples(
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
      }),
    `Examples:

  # fetch full content by article URL (most common — copy from 'rss articles' output)
  agentio rss get https://blog.fsck.com https://blog.fsck.com/2025/12/27/streamlinear/

  # by GUID (also shown in the articles list)
  agentio rss get https://simonwillison.net "tag:simonwillison.net,2024:/blog/2024/jan/12/article"`,
  );

  // Get feed info
  addExamples(
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
      }),
    `Examples:

  # title, description, discovered feed URL, article count
  agentio rss info https://kau.sh

  # also accepts a direct feed URL
  agentio rss info https://example.com/atom.xml

Auto-discovery looks for HTML <link rel="alternate"> tags first, then falls
back to common paths: /feed, /feed.xml, /rss.xml, /atom.xml, /index.xml.`,
  );
}
