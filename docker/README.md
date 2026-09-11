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
  -p 7890:7890 \
  -v agentio-data:/data \
  --restart unless-stopped \
  agentio
```

The entrypoint fetches the agentio binary (pin with `AGENTIO_VERSION`), runs `agentio vault import` when those env vars are set, then starts the daemon.

## Environment

| Variable | Description |
|----------|-------------|
| `AGENTIO_KEY` | Encryption key from `agentio vault export` |
| `AGENTIO_CONFIG` | Encrypted config from `agentio vault export` |
| `AGENTIO_VERSION` | Optional: pin binary version (default: latest release) |

## Volumes / health

| Path | Description |
|------|-------------|
| `/data` | Vault + daemon state (`HOME` / `XDG_CONFIG_HOME`) |

Health check: `GET http://localhost:7890/health`

```bash
docker inspect --format='{{.State.Health.Status}}' agentio
docker logs -f agentio
```

## Notes

- Image name `plosson999/agentio-gateway` in `push.sh` is a legacy registry tag; the container runs **daemon**, not a removed `gateway` CLI.
- There is no WhatsApp pairing, `mcp teleport`, Cloudflare Tunnel, or Caddy mode in this image — those were undocumented/unshipped fiction and were removed.
