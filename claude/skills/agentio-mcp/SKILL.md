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
