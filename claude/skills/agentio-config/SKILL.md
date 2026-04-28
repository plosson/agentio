---
name: agentio-config
description: Use when interacting with config via the agentio CLI.
---

# Config via agentio

Auto-generated from `agentio skill config`. Do not edit by hand.

## agentio config export

Export configuration and credentials (as environment variables by default, or to a file)

Options:

- `--key <key>`: Encryption key (64 hex characters). If not provided, a random key will be generated
- `--file <path>`: Write encrypted config to file instead of outputting AGENTIO_CONFIG
- `--all`: Export all profiles without prompting for selection

```
Examples:

  # interactive picker, prints AGENTIO_KEY=… and AGENTIO_CONFIG=… to stdout
  agentio config export

  # export every profile non-interactively (good in scripts / CI)
  agentio config export --all

  # write the encrypted blob to a file; only AGENTIO_KEY goes to stdout
  agentio config export --all --file ./agentio.enc

  # bring your own encryption key (64 hex chars)
  agentio config export --all --key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## agentio config import [file]

Import configuration and credentials from an encrypted file or environment variables

Options:

- `--key <key>`: Encryption key (64 hex characters). Falls back to AGENTIO_KEY env var
- `--merge`: Merge with existing configuration instead of replacing

```
Examples:

  # import from a file (key passed inline)
  agentio config import ./agentio.enc --key 0123…cdef

  # import from AGENTIO_CONFIG env var, key from AGENTIO_KEY env var
  AGENTIO_KEY=… AGENTIO_CONFIG=… agentio config import

  # merge into existing config (only adds missing profiles/credentials)
  agentio config import ./agentio.enc --key 0123…cdef --merge
```

## agentio config env set <key> <value>

Set an environment variable

```
Examples:

  # set a variable that downstream services / hooks can read
  agentio config env set OPENAI_API_KEY sk-...

  # values can contain spaces if quoted
  agentio config env set GREETING "hello world"
```

## agentio config env unset <key>

Remove an environment variable

```
Examples:

  # remove a previously-set variable
  agentio config env unset OPENAI_API_KEY
```

## agentio config clear

Clear all configuration and credentials

Options:

- `--force`: Skip confirmation prompt

```
Examples:

  # interactive: deletes all profiles and credentials after confirmation
  agentio config clear

  # non-interactive (CI / scripted reset)
  agentio config clear --force
```

