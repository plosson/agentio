---
name: agentio-github
description: Use when interacting with GitHub via the agentio CLI.
---

# Github via agentio

Auto-generated from `agentio skill github`. Do not edit by hand.

## agentio github install <repo>

Install AGENTIO_KEY and AGENTIO_CONFIG as GitHub Actions secrets

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # install secrets into a repo using the default github profile
  agentio github install octocat/hello-world

  # install secrets using a named profile
  agentio github install octocat/hello-world --profile work
```

## agentio github uninstall <repo>

Remove AGENTIO_KEY and AGENTIO_CONFIG secrets from a repository

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # remove the agentio secrets from a repo
  agentio github uninstall octocat/hello-world

  # uninstall using a named profile
  agentio github uninstall octocat/hello-world --profile work
```
