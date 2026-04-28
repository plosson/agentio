---
name: agentio-telegram
description: Use when interacting with Telegram via the agentio CLI - send messages, manage inbox/outbox via the daemon.
---

# Telegram via agentio

Auto-generated from `agentio skill telegram`. Do not edit by hand.

## agentio telegram send [message]

Send a message to the channel

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--parse-mode <mode>`: Message format: html or markdown
- `--silent`: Send without notification

```
Examples:

  # plain-text message to the channel
  agentio telegram send "Deploy completed"

  # body from stdin (good for piping)
  echo "Build green" | agentio telegram send

  # HTML formatting
  agentio telegram send "<b>Alert</b>: disk 90% full" --parse-mode html

  # silent notification (no device ping)
  agentio telegram send "Nightly job done" --silent
```

## agentio telegram inbox pull

Get pending messages from inbox

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Maximum messages to retrieve (default: 50)
- `--status <status>`: Filter by status: pending or done (default: pending)

```
Examples:

  # newest pending messages (default limit 50)
  agentio telegram inbox pull

  # only the 10 most recent pending
  agentio telegram inbox pull --limit 10

  # already-acknowledged messages (audit trail)
  agentio telegram inbox pull --status done --limit 20
```

## agentio telegram inbox get <id>

Get a specific inbox message

```
Examples:

  # full message (text, sender, chat id) by inbox ID
  agentio telegram inbox get tg_inbox_01HXYZABC123
```

## agentio telegram inbox ack <id>

Mark a message as done

```
Examples:

  # mark a message as handled (removes from default 'pending' pulls)
  agentio telegram inbox ack tg_inbox_01HXYZABC123
```

## agentio telegram inbox reply <id> [message]

Reply to an inbox message

```
Examples:

  # reply inline as an argument
  agentio telegram inbox reply tg_inbox_01HXYZABC123 "On it, thanks!"

  # reply via stdin (good for multi-line / piped output)
  echo "Done — see PR #42" | agentio telegram inbox reply tg_inbox_01HXYZABC123
```

## agentio telegram inbox stats

Get inbox statistics

Options:

- `--profile <name>`: Profile name

```
Examples:

  # pending vs done counts across all telegram profiles
  agentio telegram inbox stats

  # scoped to one bot profile
  agentio telegram inbox stats --profile my_announce_bot
```

## agentio telegram outbox send [message]

Queue a message for sending

Options:

- `--profile <name>`: Profile name
- `--to <chat-id>`: Destination chat ID (required)
- `--parse-mode <mode>`: Message format: html or markdown

```
Examples:

  # queue a message to a private chat (positive numeric chat id)
  agentio telegram outbox send --to 123456789 "Reminder: standup at 10am"

  # queue to a channel/supergroup (chat ids start with -100)
  agentio telegram outbox send --to -1001234567890 "Deploy started"

  # HTML formatting + body via stdin
  cat report.html | agentio telegram outbox send --to 123456789 --parse-mode html
```

## agentio telegram outbox status <id>

Check send status of a message

```
Examples:

  # check whether a queued message is pending/sending/sent/failed
  agentio telegram outbox status tg_outbox_01HXYZABC123
```

## agentio telegram outbox list

List outbox messages

Options:

- `--profile <name>`: Profile name
- `--status <status>`: Filter by status: pending, sending, sent, or failed
- `--limit <n>`: Maximum messages to retrieve (default: 50)

```
Examples:

  # most recent outbox entries (default limit 50)
  agentio telegram outbox list

  # only failed sends — useful when debugging
  agentio telegram outbox list --status failed

  # last 10 successfully delivered messages on a specific bot
  agentio telegram outbox list --profile my_announce_bot --status sent --limit 10
```

