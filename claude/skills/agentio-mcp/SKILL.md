---
name: agentio-mcp
description: Use when interacting with mcp via the agentio CLI.
---

# Mcp via agentio

Auto-generated from `agentio skill mcp`. Do not edit by hand.

## agentio mcp serve <pairs...>

Start stdio MCP server exposing CLI commands as tools

```
Examples:

  # expose a single profile as MCP tools (stdio transport)
  agentio mcp serve gmail:work

  # expose multiple services / profiles in one server
  agentio mcp serve gmail:work slack:team rss

  # use the default profile (omit `:profile`)
  agentio mcp serve rss
```

## agentio mcp install [pairs...]

Install MCP server config into .mcp.json

```
Examples:

  # interactive picker over your configured profiles
  agentio mcp install

  # write .mcp.json non-interactively for specific pairs
  agentio mcp install gmail:work slack:team

  # default profile for one service
  agentio mcp install rss
```

## agentio mcp teleport [name]

Deploy the agentio HTTP MCP server to a siteio-managed remote in one command

Options:

- `--dockerfile-only`: Print (or write) the Dockerfile without calling siteio
- `--output <path>`: Used with --dockerfile-only to write the Dockerfile to a file instead of stdout
- `--dry-run`: Run preflight + config export but do not invoke siteio; print the commands that would run
- `--no-cache`: Pass --no-cache to `siteio apps deploy` to force a fresh Docker build
- `--git-branch <branch>`: Deploy unreleased code by telling siteio to clone this repo and build docker/Dockerfile.teleport from the given branch (instead of fetching the latest release binary)
- `--git-url <url>`: Override the git URL siteio clones from. Default: detected via `git remote get-url origin`, normalized to HTTPS
- `--sync`: Push the latest local config (profiles + credentials) to an EXISTING siteio app and restart it. Use after adding/changing a profile. Does not rebuild the image; does not change the operator API key.

```
Examples:

  # first deploy: pick an app name (becomes the subdomain on your siteio host)
  agentio mcp teleport mcp

  # subsequent deploys: name is remembered — rebuild in place, preserves API key + clients
  agentio mcp teleport

  # push only the latest local config (added profiles, refreshed creds) without rebuilding
  agentio mcp teleport --sync

  # deploy unreleased code from a branch (siteio clones the repo and builds from it)
  agentio mcp teleport mcp --git-branch feat/my-branch

  # inspect the generated Dockerfile without calling siteio
  agentio mcp teleport mcp --dockerfile-only
```

