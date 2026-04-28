---
name: agentio-status
description: Use when interacting with status via the agentio CLI.
---

# Status via agentio

Auto-generated from `agentio skill status`. Do not edit by hand.

## agentio status

Show configured profiles and credential status

Options:

- `--no-test`: Skip credential testing
- `--json`: Output in JSON format

```
Examples:

  # show every configured profile and test its credentials
  agentio status

  # show profiles without making test API calls (fast; no network)
  agentio status --no-test

  # JSON output (good for piping to jq or another agent)
  agentio status --json
```

