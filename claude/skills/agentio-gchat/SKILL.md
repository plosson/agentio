---
name: agentio-gchat
description: Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history.
---

# Gchat via agentio

Auto-generated from `agentio skill gchat`. Do not edit by hand.

## agentio gchat send [message]

Send a message to Google Chat

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--space <id>`: Space ID (required for OAuth profiles)
- `--thread <id>`: Thread ID (optional)
- `--json [file]`: Send rich message from JSON file (or stdin if no file specified)
- `--attachment <path>`: File to attach (repeatable, OAuth profiles only) (default: )

```
Examples:

  # webhook profile: short text, no --space needed
  agentio gchat send "Deployment complete"

  # OAuth profile: send to a specific space
  agentio gchat send "Status update" --space spaces/AAAA1234

  # reply within an existing thread
  agentio gchat send "Following up" --space spaces/AAAA1234 --thread spaces/AAAA1234/threads/abcDEF

  # rich card via JSON file (OAuth or webhook)
  agentio gchat send --json ./card.json --space spaces/AAAA1234

  # JSON via stdin (good for inline cards)
  echo '{"text":"Build status","cards":[{"header":{"title":"CI"}}]}' | \
    agentio gchat send --json --space spaces/AAAA1234
```

## agentio gchat list

List messages from a Google Chat space (OAuth profiles only)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--space <id>`: Space ID
- `--limit <n>`: Number of messages (default: 10)
- `--thread <id>`: Filter by thread ID
- `--since <date>`: Only messages after this date (YYYY-MM-DD)
- `--until <date>`: Only messages before this date (YYYY-MM-DD)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # 10 most recent messages in a space (OAuth only)
  agentio gchat list --space spaces/AAAA1234

  # last 50 messages
  agentio gchat list --space spaces/AAAA1234 --limit 50

  # only messages in a specific thread
  agentio gchat list --space spaces/AAAA1234 --thread spaces/AAAA1234/threads/abcDEF

  # messages within a closed date range, as JSON for scripting
  agentio gchat list --space spaces/AAAA1234 --since 2026-04-01 --until 2026-05-01 --limit 5000 --format json
```

## agentio gchat get <message-id>

Get a message from a Google Chat space (OAuth profiles only)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--space <id>`: Space ID
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # fetch one message by id from a space (OAuth only)
  agentio gchat get spaces/AAAA1234/messages/9876543210 --space spaces/AAAA1234

  # as JSON for scripting
  agentio gchat get spaces/AAAA1234/messages/9876543210 --space spaces/AAAA1234 --format json
```

## agentio gchat spaces

List available Google Chat spaces (OAuth profiles only)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--filter <text>`: Filter spaces by name (case-insensitive)
- `--with <user>`: Resolve the 1:1 DM space with a user (email, numeric id, or users/<id>)

```
Examples:

  # all spaces this OAuth profile can see
  agentio gchat spaces

  # filter by display name (case-insensitive substring)
  agentio gchat spaces --filter eng

  # resolve the 1:1 DM space with a workspace user (1 API call, instant)
  agentio gchat spaces --with pmontesel@hex-rays.com
```

## agentio gchat members

List members of a Google Chat space (OAuth profiles only)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--space <id-or-name>`: Space ID or display name

```
Examples:

  # members by space id
  agentio gchat members --space spaces/AAAA1234

  # members by space display name (resolved against the space list)
  agentio gchat members --space "Engineering"
```

## agentio gchat user <user-id>

Get full user info from the People API (OAuth profiles only)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # by raw numeric id
  agentio gchat user 123456789

  # by full users/<id> form (as it appears in 'gchat members' output)
  agentio gchat user users/123456789
```

## agentio gchat directory refresh

Force refresh the cached workspace directory (OAuth profiles only)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # rebuild the local user-id -> name/email cache (OAuth only)
  agentio gchat directory refresh

  # refresh the cache for a specific OAuth profile
  agentio gchat directory refresh --profile alice@example.com
```
