---
name: agentio-setup
description: Use when interacting with setup via the agentio CLI.
---

# Setup via agentio

Auto-generated from `agentio skill setup`. Do not edit by hand.

## agentio setup

Initialize or manage the agentio vault

Options:

- `--reset`: Wipe vault, pointer, and stored passphrase
- `--force`: Skip confirmation prompts (for --reset)

```
Examples:

  # first-time setup (interactive: prompts for vault path + passphrase)
  agentio setup

  # re-run on an already-configured vault to change passphrase or move it
  agentio setup

  # wipe the vault, pointer, and stored passphrase (asks for confirmation)
  agentio setup --reset

  # wipe non-interactively (CI / scripted reset)
  agentio setup --reset --force
```
