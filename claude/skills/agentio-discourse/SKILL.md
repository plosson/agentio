---
name: agentio-discourse
description: Use when interacting with Discourse forums via the agentio CLI.
---

# Discourse via agentio

Auto-generated from `agentio skill discourse`. Do not edit by hand.

## agentio discourse list

List latest topics

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--category <slug>`: Filter by category slug or name
- `--page <number>`: Page number (0-indexed) (default: 0)

```
Examples:

  # latest topics on the default profile
  agentio discourse list

  # second page of topics in a specific category
  agentio discourse list --category support --page 1

  # latest topics on a named profile
  agentio discourse list --profile meta
```

## agentio discourse get <topic-id>

Get a topic with its posts

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # get a topic and its posts by numeric ID
  agentio discourse get 12345

  # use a named profile
  agentio discourse get 12345 --profile meta
```

## agentio discourse categories

List all categories

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # list all visible categories
  agentio discourse categories

  # categories on a named forum profile
  agentio discourse categories --profile meta
```
