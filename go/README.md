# AgentIO Go port (skeleton)

Branch work for [issue #85](https://github.com/plosson/agentio/issues/85) / [PR #86](https://github.com/plosson/agentio/pull/86).

**In scope for this skeleton**

- AES-256-GCM vault compatible with the Bun `vault.enc` wire format (scrypt N=16384,r=8,p=1)
- Daemon `agentio daemon start` with `GET /health` (port 7890)
- **Central profile registry** (`agentio profile add|list|remove`) — services do not own CRUD
- **Gmail** as the first end-to-end service: OAuth loopback, profile add/list, `profile-info`, `labels list`

**Explicitly out of scope (for now)**

- External TypeScript plugins (`AGENTIO_PLUGIN_PATHS`)
- WhatsApp / Baileys / whatsmeow
- All other services
- Full daemon v1 credential API / admin UI

## Layout (Go idioms + Bun modularity)

```
go/
  cmd/agentio/           # binary entry
  internal/
    vault/               # AES-GCM/scrypt crypto + encrypted store
    daemon/              # local HTTP daemon
    profile/             # shared add/list/get/remove for any service key
    oauth/               # Google OAuth helpers (obscured client secret, loopback)
    services/
      gmail/             # Gmail OAuth setup + Gmail API client only
    cli/                 # cobra commands wiring the above
```

Bun preserves the same *organization principle*: one package per service under
`internal/services/`, all depending on shared core (`vault`, `daemon`, `profile`).
Directory names follow Go conventions (`internal/`, `cmd/`), not a literal `src/plugins/` mirror.

Gmail runs OAuth and returns credentials; `internal/profile` names and persists them.
Gmail must not reimplement vault crypto or daemon HTTP.

## Build

```bash
cd go
go test ./...
go build -o agentio ./cmd/agentio
```

## Smoke

```bash
export AGENTIO_PASSPHRASE='…'
./agentio vault init --passphrase-stdin <<< "$AGENTIO_PASSPHRASE"
./agentio daemon start   # elsewhere: curl -s localhost:7890/health
./agentio profile add gmail
# or: ./agentio gmail profile add
./agentio profile list
./agentio gmail profile-info
./agentio gmail labels list
```

This binary is a **parallel** Go tree under `go/`; the Bun `agentio` on `main` is unchanged. Do not merge until reviewed.
