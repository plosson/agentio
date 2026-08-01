---
name: agentio-telegram
description: Use when sending Telegram messages via the agentio CLI.
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
