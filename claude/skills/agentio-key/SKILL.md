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
- `--can-manage-profiles`: Let the agent add, replace, rename and delete profiles from its machine (default: false)
- `--requests-per-minute <n>`: Hub requests a minute this key may make (default 120); "unlimited" or 0 for no limit

```
Examples:

  # a key for one agent, limited to two profiles
  agentio key create claudiu --url https://vault.example.com --profiles gdrive/docunit,gmail/work

  # everything, but read-only
  agentio key create reporter --url https://vault.example.com --all --read-only

  # a laptop that manages its own profiles in the vault
  agentio key create laptop --url https://vault.example.com --all --can-manage-profiles

  # one key shared by every agent on a busy machine, with no request cap
  agentio key create box --url https://vault.example.com --all --requests-per-minute unlimited

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

Rename a key or change its scope, flags or request limit

Options:

- `--name <name>`: New display name
- `--profiles <list>`: Comma-separated service/name pairs the key may use
- `--all`: Allow every profile
- `--read-only`: Force read-only
- `--no-read-only`: Lift the key-level read-only restriction
- `--can-manage-profiles`: Let the agent add, replace, rename and delete profiles from its machine
- `--no-can-manage-profiles`: Stop the agent from managing profiles
- `--requests-per-minute <n>`: Hub requests a minute this key may make (default 120); "unlimited" or 0 for no limit

```
Examples:

  agentio key update a1b2c3d4 --profiles gdrive/docunit
  agentio key update a1b2c3d4 --no-read-only
  agentio key update a1b2c3d4 --can-manage-profiles
  agentio key update a1b2c3d4 --requests-per-minute 600
  agentio key update a1b2c3d4 --requests-per-minute unlimited
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

