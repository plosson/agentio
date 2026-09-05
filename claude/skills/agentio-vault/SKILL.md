---
name: agentio-vault
description: Use when interacting with vault via the agentio CLI.
---

# Vault via agentio

Auto-generated from `agentio skill vault`. Do not edit by hand.

## agentio vault init

Create a new vault

Options:

- `--path <path>`: Where to create the vault file
- `--passphrase <value>`: Vault passphrase (visible in shell history and process list)
- `--passphrase-stdin`: Read the vault passphrase from stdin
- `--no-migrate`: Ignore any legacy config instead of importing it

```
Examples:

  # interactive first-time setup
  agentio vault init

  # non-interactive, passphrase piped in
  printf %s "$VAULT_PW" | agentio vault init --path ~/.config/agentio/vault.enc --passphrase-stdin

  # create a fresh vault, ignoring any legacy config on this machine
  agentio vault init --no-migrate

To use a vault that already exists, run 'agentio vault set <path>' instead.
```

## agentio vault passphrase

Change the passphrase of the current vault

Options:

- `--passphrase <value>`: New passphrase (visible in shell history and process list)
- `--passphrase-stdin`: Read the new passphrase from stdin

```
Examples:

  # change the passphrase, prompting for the new one
  agentio vault passphrase

  # non-interactive
  printf %s "$NEW_PW" | agentio vault passphrase --passphrase-stdin
```

## agentio vault reset

Delete the vault file, pointer, and stored passphrase

Options:

- `--force`: Skip the confirmation prompt

```
Examples:

  # wipe the vault (asks for confirmation)
  agentio vault reset

  # wipe non-interactively (CI / scripted reset)
  agentio vault reset --force

This deletes the vault file itself. To simply stop using a vault without
destroying it, point agentio elsewhere with 'agentio vault set <path>'.
```

## agentio vault export

Export configuration and credentials (as environment variables by default, or to a file)

Options:

- `--key <key>`: Encryption key (64 hex characters). If not provided, a random key will be generated
- `--file <path>`: Write encrypted config to file instead of outputting AGENTIO_CONFIG
- `--all`: Export all profiles without prompting for selection

```
Examples:

  # interactive picker, prints AGENTIO_KEY=… and AGENTIO_CONFIG=… to stdout
  agentio vault export

  # export every profile non-interactively (good in scripts / CI)
  agentio vault export --all

  # write the encrypted blob to a file; only AGENTIO_KEY goes to stdout
  agentio vault export --all --file ./agentio.enc

  # bring your own encryption key (64 hex chars)
  agentio vault export --all --key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

## agentio vault import [file]

Import configuration and credentials from an encrypted file or environment variables

Options:

- `--key <key>`: Encryption key (64 hex characters). Falls back to AGENTIO_KEY env var
- `--merge`: Merge with existing configuration instead of replacing

```
Examples:

  # import from a file (key passed inline)
  agentio vault import ./agentio.enc --key 0123…cdef

  # import from AGENTIO_CONFIG env var, key from AGENTIO_KEY env var
  AGENTIO_KEY=… AGENTIO_CONFIG=… agentio vault import

  # merge into existing config (only adds missing profiles/credentials)
  agentio vault import ./agentio.enc --key 0123…cdef --merge
```

## agentio vault env set <key> <value>

Set an environment variable

```
Examples:

  # point the CLI at a remote daemon
  agentio vault env set AGENTIO_DAEMON_URL http://box.local:7890
  agentio vault env set AGENTIO_DAEMON_API_KEY secret

Stored variables are read by agentio itself, NOT exported to your shell or to
processes agentio spawns (scheduled .run.md jobs inherit your real environment,
not these). Only AGENTIO_DAEMON_URL and AGENTIO_DAEMON_API_KEY are consulted
today; other keys are carried by 'vault export'/'import' but nothing reads them.
```

## agentio vault env unset <key>

Remove an environment variable

```
Examples:

  # remove a previously-set variable
  agentio vault env unset OPENAI_API_KEY
```

## agentio vault clear

Clear all configuration and credentials

Options:

- `--force`: Skip confirmation prompt

```
Examples:

  # interactive: deletes all profiles and credentials after confirmation
  agentio vault clear

  # non-interactive (CI / scripted reset)
  agentio vault clear --force
```

## agentio vault status

Show the active vault and what it holds

```
Examples:

  # show the active vault path and profile count
  agentio vault status
```

## agentio vault set <path>

Point agentio at an existing vault file

Options:

- `--passphrase <value>`: Vault passphrase (visible in shell history and process list)
- `--passphrase-stdin`: Read the vault passphrase from stdin

```
Examples:

  # switch to another vault, prompting for the passphrase
  agentio vault set ~/Dropbox/agentio/work.vault

  # non-interactive, passphrase piped in (keeps it out of history and ps)
  printf %s "$VAULT_PW" | agentio vault set /path/to/work.vault --passphrase-stdin

  # non-interactive via the environment
  AGENTIO_PASSPHRASE="$VAULT_PW" agentio vault set /path/to/work.vault

  # non-interactive as a flag (visible in shell history and process list)
  agentio vault set /path/to/work.vault --passphrase "$VAULT_PW"

Only the pointer and the stored passphrase change - neither vault file is
moved, written to, or deleted. Run 'agentio doctor' to see the active vault.
```
