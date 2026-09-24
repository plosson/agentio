// Package rss is the RSS service. It has no profile: commands run with no
// credentials and take the blog or feed URL as an argument.
package rss

import (
	"context"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "rss",
		DisplayName: "RSS",
		Description: "Use when reading RSS feeds via the agentio CLI.",
		Commands:    []plugins.CommandSpec{articlesCmd(), getCmd(), infoCmd()},
	}
}

var urlArg = plugins.ArgumentSpec{Name: "url", Description: "Blog URL (feed will be auto-discovered)", Required: true}

func newClient(ctx context.Context, run *plugins.RunContext) *client {
	return &client{ctx: ctx, fetch: run.Fetch, fail: run.Fail}
}

func articlesCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "articles",
		Description: "List articles from a blog",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{urlArg},
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Number of articles", DefaultValue: "20"},
			{Flags: "--since <date>", Description: "Only articles after this date (YYYY-MM-DD)"},
		},
		Examples: []string{
			"# 20 most recent articles (feed auto-discovered from blog URL)",
			"agentio rss articles https://simonwillison.net",
			"# cap to 5 articles",
			"agentio rss articles https://simonwillison.net --limit 5",
			"# only articles since a date",
			"agentio rss articles https://steipete.me --since 2026-01-01",
			"# direct feed URL also works",
			"agentio rss articles https://example.com/feed.xml --limit 10",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			limit := jsvalue.ParseInt(in.Option("limit"))
			var since *time.Time
			sinceValid := false
			if s := in.Option("since"); s != "" {
				t, ok := jsvalue.ParseDate(s)
				since, sinceValid = &t, ok
			}
			c := newClient(ctx, run)
			info, err := c.getInfo(in.Arg("url"))
			if err != nil {
				return nil, err
			}
			articles, err := c.list(in.Arg("url"), limit, since, sinceValid)
			if err != nil {
				return nil, err
			}
			return render(articleList{Feed: info.Title, Articles: articles})
		},
		Format:   format,
		Verbatim: true,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get a specific article",
		Access:      "read",
		Arguments: []plugins.ArgumentSpec{
			urlArg,
			{Name: "article-id", Description: "Article ID or URL", Required: true},
		},
		Examples: []string{
			"# fetch full content by article URL (most common — copy from 'rss articles' output)",
			"agentio rss get https://blog.fsck.com https://blog.fsck.com/2025/12/27/streamlinear/",
			"# by GUID (also shown in the articles list)",
			`agentio rss get https://simonwillison.net "tag:simonwillison.net,2024:/blog/2024/jan/12/article"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := newClient(ctx, run).get(in.Arg("url"), in.Arg("article-id"))
			if err != nil {
				return nil, err
			}
			return render(a)
		},
		Format:   format,
		Verbatim: true,
	}
}

func infoCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "info",
		Description: "Get feed information",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{urlArg},
		Examples: []string{
			"# title, description, discovered feed URL, article count",
			"agentio rss info https://kau.sh",
			"# also accepts a direct feed URL",
			"agentio rss info https://example.com/atom.xml",
			`# Auto-discovery looks for HTML <link rel="alternate"> tags first, then falls`,
			"# back to common paths: /feed, /feed.xml, /rss.xml, /atom.xml, /index.xml.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			info, err := newClient(ctx, run).getInfo(in.Arg("url"))
			if err != nil {
				return nil, err
			}
			return render(info)
		},
		Format:   format,
		Verbatim: true,
	}
}
