# agentio Go host

A Go port of the agentio host: the encrypted vault, profiles, credential
refresh, the declarative plugin contract, and the local credential hub.

No real service is included. Three fake plugins exercise the host. The Bun CLI
on `main` is unchanged.

## Build

```bash
cd go
go test ./...
go build -o agentio ./cmd/agentio
```

`go run ./cmd/agentio` works the same way. This binary is not the `agentio` on
your PATH.

## Do not point it at a real vault

The binary uses the same `~/.config/agentio` directory as the Bun CLI: the
vault pointer, the passphrase file, and the hub token. A normal home directory
that already has agentio configured is a live vault.

Try it under an empty home:

```bash
export HOME=$(mktemp -d)
export AGENTIO_PASSPHRASE='test-pass-123'
go run ./cmd/agentio vault init --passphrase "$AGENTIO_PASSPHRASE"
go run ./cmd/agentio ping once
```

`--help`, `docs`, `plugin list`, and `skill` only print text. Other commands
open whatever vault that home points at. `logout` deletes the token file.
`vault reset --force`, `vault clear --force`, `vault import`, `vault
passphrase`, and `vault set` rewrite the vault.

## Fake services

| Command | What it is |
| --- | --- |
| `ping` | No stored credentials. `ping once` prints `pong`. |
| `board` | A static API token. The hub returns the whole credential. |
| `acme` | Short-lived tokens. The host refreshes and redacts the refresh token. |

```bash
go run ./cmd/agentio plugin list
go run ./cmd/agentio acme profile add
go run ./cmd/agentio acme whoami --json
go run ./cmd/agentio status
```

`acme profile add` asks for an account name, then for an authorization code.
Paste `old|rt|1` to store access token `old`, refresh token `rt`, and an
expiry already in the past. The next command refreshes it.

## Hub

```bash
go run ./cmd/agentio daemon start
```

Listens on `0.0.0.0:7890`. With `AGENTIO_PASSPHRASE` set, the vault unlocks at
startup. Otherwise open `http://127.0.0.1:7890/ui` and unlock there. `GET
/health` answers while the vault is locked.

## Vault files

The on-disk format matches Bun: base64 of salt, a 16-byte IV, and AES-256-GCM
ciphertext, with scrypt N=16384, r=8, p=1. A vault written by one CLI opens in
the other. `go test ./internal/vault` checks that round trip.

Default new vault: `$HOME/.config/agentio/vault.enc`, named by
`$HOME/.config/agentio/vault.path`.
