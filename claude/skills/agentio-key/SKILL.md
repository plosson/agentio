---
name: agentio-key
description: Use to manage the API keys that let remote agents read credentials from this vault hub - create, list, update, rotate, revoke.
---

# Key via agentio

Auto-generated from `agentio skill key`. Do not edit by hand.

## agentio key create <name>

Create a key and print its token once

Options:

- `--url <url>`: Public base URL of this hub, embedded in the token
- `--profiles <list>`: Comma-separated service/name pairs the key may use
- `--all`: Allow every profile
- `--read-only`: Force read-only on every profile the key can see (default: false)

```
Examples:

  # a key for one agent, limited to two profiles
  agentio key create claudiu --url https://vault.example.com --profiles gdrive/docunit,gmail/work

  # everything, but read-only
  agentio key create reporter --url https://vault.example.com --all --read-only

  # capture the token for a deploy script
  AGENTIO_TOKEN=$(agentio key create ci --url https://vault.example.com --all)
```

## agentio key list

List keys (never the secrets)

```
Examples:

  agentio key list
```

## agentio key update <id>

Rename a key or change its scope

Options:

- `--name <name>`: New display name
- `--profiles <list>`: Comma-separated service/name pairs the key may use
- `--all`: Allow every profile
- `--read-only`: Force read-only
- `--no-read-only`: Lift the key-level read-only restriction

```
Examples:

  agentio key update a1b2c3d4 --profiles gdrive/docunit
  agentio key update a1b2c3d4 --no-read-only
```

## agentio key rotate <id>

Replace the secret; the old token stops working at once

Options:

- `--url <url>`: Public base URL of this hub, embedded in the new token

```
Examples:

  agentio key rotate a1b2c3d4 --url https://vault.example.com
```

## agentio key revoke <id>

Delete a key; its token stops working at once

```
Examples:

  agentio key revoke a1b2c3d4
```

