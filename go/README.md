# AgentIO Go port (skeleton)

Branch work for [issue #85](https://github.com/plosson/agentio/issues/85) / [PR #86](https://github.com/plosson/agentio/pull/86).

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the Bun → Go boundary map.
See **[MIGRATION.md](./MIGRATION.md)** for the agent-followable strangler playbook (phases, per-service checklist, DoD).
See **[COVERAGE.md](./COVERAGE.md)** for the Gmail/Jira command parity matrix (update in the same PR as ports).

**In scope for this skeleton**

- AES-256-GCM vault compatible with the Bun `vault.enc` wire format (scrypt N=16384,r=8,p=1)
- Daemon `agentio daemon start` with `GET /health` (port 7890)
- **Central profile registry** (`agentio profile add|list|remove|rename`) — services do not own CRUD
- **`service.ServicePlugin` contract** + registry (Bun plugin boundary)
- **Gmail** + **Jira** as first two end-to-end services (OAuth setup → shared persist → API cmds)

**Explicitly out of scope (for now)**

- External TypeScript plugins (`AGENTIO_PLUGIN_PATHS`)
- WhatsApp / Baileys / whatsmeow
- Full daemon v1 credential API / admin UI
- CredentialLifecycle refresh / reauth

## Layout

```
go/
  cmd/agentio/
  internal/
    vault/                 # AES-GCM/scrypt + VaultContents store
    daemon/                # local HTTP daemon
    profile/               # SaveProfile / DeleteProfile / AddProfileFromPlugin …
    service/               # ServicePlugin + Registry (Bun plugin contract)
    oauth/                 # shared Google helpers + obscure Reveal
    services/
      gmail/               # Gmail Setup + API (implements ServicePlugin)
      jira/                # Jira Setup + API (implements ServicePlugin)
    cli/                   # cobra wiring (profile CRUD is shared)
  ARCHITECTURE.md
  MIGRATION.md
  COVERAGE.md
```

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
./agentio profile add gmail
./agentio profile add jira
./agentio profile list
./agentio gmail profile-info
./agentio jira myself
./agentio jira projects
```

This binary is a **parallel** Go tree under `go/`; the Bun `agentio` on `main` is unchanged. Do not merge until reviewed.
