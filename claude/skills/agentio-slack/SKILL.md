---
name: agentio-slack
description: Use when sending Slack messages via the agentio CLI.
---

# Slack via agentio

Auto-generated from `agentio skill slack`. Do not edit by hand.

## agentio slack send [message]

Send a message to Slack

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json [file]`: Send Block Kit message from JSON file (or stdin if no file specified)

```
Examples:

  # send a quick text message to the default profile
  agentio slack send "deploy finished"

  # pipe message body via stdin
  echo "build failed: see logs" | agentio slack send

  # send a Block Kit payload from a JSON file
  agentio slack send --json ./alert.json

  # send to a specific profile
  agentio slack send --profile alerts "incident opened"
```

