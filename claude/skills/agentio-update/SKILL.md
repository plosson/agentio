---
name: agentio-update
description: Use when interacting with update via the agentio CLI.
---

# Update via agentio

Auto-generated from `agentio skill update`. Do not edit by hand.

## agentio update

Update agentio to the latest version

Options:

- `--check`: Only check for updates, don't install
- `--force`: Force update even if already on latest version
- `-y, --yes`: Skip confirmation prompt

```
Examples:

  # check for a newer release and install it (asks for confirmation)
  agentio update

  # only check (no download)
  agentio update --check

  # non-interactive update (skip confirmation; useful in scripts)
  agentio update --yes

  # reinstall the same version (e.g. recover a corrupted binary)
  agentio update --force --yes
```
