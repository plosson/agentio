# AgentIO Go port (skeleton)

Branch work for [issue #85](https://github.com/plosson/agentio/issues/85).

**In scope for this skeleton**

- AES-256-GCM vault compatible with the Bun `vault.enc` wire format (scrypt N=16384,r=8,p=1)
- Daemon `agentio daemon start` with `GET /health` (port 7890)
- **Gmail** as the first end-to-end service: OAuth loopback, profile add/list, `profile-info`, `labels list`

**Explicitly out of scope (for now)**

- External TypeScript plugins (`AGENTIO_PLUGIN_PATHS`)
- WhatsApp / Baileys / whatsmeow
- All other services
- Full daemon v1 credential API / admin UI

## Why Gmail first

Official `google.golang.org/api` + `golang.org/x/oauth2` are mature and maintained. Jira’s Go clients are thinner (community `go-jira` v2 unstable) and Atlassian 3LO is a worse first OAuth target.

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
./agentio gmail profile add
./agentio gmail profile-info
./agentio gmail labels list
```

This binary is a **parallel** Go tree under `go/`; the Bun `agentio` on `main` is unchanged. Do not merge until reviewed.
