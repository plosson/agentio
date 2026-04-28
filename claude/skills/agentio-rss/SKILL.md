---
name: agentio-rss
description: Use when reading RSS feeds via the agentio CLI.
---

# Rss via agentio

Auto-generated from `agentio skill rss`. Do not edit by hand.

## agentio rss articles <url>

List articles from a blog

Options:

- `--limit <n>`: Number of articles (default: 20)
- `--since <date>`: Only articles after this date (YYYY-MM-DD)

```
Examples:

  # 20 most recent articles (feed auto-discovered from blog URL)
  agentio rss articles https://simonwillison.net

  # cap to 5 articles
  agentio rss articles https://simonwillison.net --limit 5

  # only articles since a date
  agentio rss articles https://steipete.me --since 2026-01-01

  # direct feed URL also works
  agentio rss articles https://example.com/feed.xml --limit 10
```

## agentio rss get <url> <article-id>

Get a specific article

```
Examples:

  # fetch full content by article URL (most common — copy from 'rss articles' output)
  agentio rss get https://blog.fsck.com https://blog.fsck.com/2025/12/27/streamlinear/

  # by GUID (also shown in the articles list)
  agentio rss get https://simonwillison.net "tag:simonwillison.net,2024:/blog/2024/jan/12/article"
```

## agentio rss info <url>

Get feed information

```
Examples:

  # title, description, discovered feed URL, article count
  agentio rss info https://kau.sh

  # also accepts a direct feed URL
  agentio rss info https://example.com/atom.xml

Auto-discovery looks for HTML <link rel="alternate"> tags first, then falls
back to common paths: /feed, /feed.xml, /rss.xml, /atom.xml, /index.xml.
```
