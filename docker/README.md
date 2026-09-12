# Agentio daemon Docker

Runs the shipped CLI daemon (`agentio daemon start`), which serves the daemon API on port 7890. This image is the only supported way to run the daemon.

## Build

From the repository root:

```bash
docker build -f docker/Dockerfile -t agentio .
```

## Run

Export vault credentials locally first:

```bash
agentio vault export
# prints AGENTIO_KEY=… and AGENTIO_CONFIG=…
```

Then:

```bash
docker run -d \
  --name agentio \
  -e AGENTIO_KEY=your_key_here \
  -e AGENTIO_CONFIG=your_config_here \
  -e AGENTIO_PASSPHRASE=your_vault_passphrase \
  -p 7890:7890 \
  -v agentio-data:/data \
  --restart unless-stopped \
  agentio
```

The entrypoint fetches the agentio binary (pin with `AGENTIO_VERSION`), then starts the daemon. On the **first boot** of a volume, when `AGENTIO_KEY` and `AGENTIO_CONFIG` are set, it runs `agentio vault import` to create the vault from them; that needs `AGENTIO_PASSPHRASE` because there is no terminal to prompt. Once a vault exists on the volume it is never overwritten by the env vars.

## Environment

| Variable | Description |
|----------|-------------|
| `AGENTIO_KEY` | Encryption key from `agentio vault export`, used on first boot only |
| `AGENTIO_CONFIG` | Encrypted config from `agentio vault export`, used on first boot only |
| `AGENTIO_VERSION` | Optional: pin binary version (default: latest release) |
| `AGENTIO_PASSPHRASE` | Vault passphrase. Required on first boot to create the vault; afterwards optional: when set the daemon starts unlocked, otherwise it starts locked until someone unlocks it at `/ui` |

## Volumes / health

| Path | Description |
|------|-------------|
| `/data` | Vault + daemon state (`HOME` / `XDG_CONFIG_HOME`) |

Health check: `GET http://localhost:7890/health`. It answers 200 whether the vault is locked or not, and the body carries `locked`.

Admin UI: `http://localhost:7890/ui`. Put TLS in front before exposing it; the passphrase travels in the unlock request.

```bash
docker inspect --format='{{.State.Health.Status}}' agentio
docker logs -f agentio
```

## Notes

- Image name `plosson999/agentio-gateway` in `push.sh` is a legacy registry tag; the container runs **daemon**, not a removed `gateway` CLI.
- There is no WhatsApp pairing, `mcp teleport`, Cloudflare Tunnel, or Caddy mode in this image — those were undocumented/unshipped fiction and were removed.
