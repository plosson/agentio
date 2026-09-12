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

## Running the vault hub on a VPS

This is the deployment the remote-vault design targets: one container on a public host, siteio (or any TLS proxy) in front, agents elsewhere holding one token each.

### 1. Prepare the vault export on your machine

```bash
agentio vault export --all
# prints AGENTIO_KEY=… and AGENTIO_CONFIG=…
```

### 2. Start the container

```bash
docker run -d \
  --name agentio \
  -e AGENTIO_KEY=… \
  -e AGENTIO_CONFIG=… \
  -e AGENTIO_PASSPHRASE=… \
  -p 127.0.0.1:7890:7890 \
  -v agentio-data:/data \
  --restart unless-stopped \
  agentio
```

- Publish the port on the loopback address only, as above, or firewall 7890 so that only the TLS proxy can reach it. The daemon speaks plain HTTP and the passphrase travels in the unlock request.
- `AGENTIO_PASSPHRASE` is needed on the first boot so `vault import` can create the vault without a terminal. Keep it set if you want restarts to come up unlocked; drop it if you prefer to unlock by hand at `/ui` after every restart.
- The env vars seed the vault once. After that the volume is the source of truth and a restart never overwrites it.

### 3. Put TLS in front

Point siteio, Caddy, or nginx at `http://127.0.0.1:7890` under your domain. The daemon reads `X-Forwarded-For` for its rate limits, so the proxy must set it. Open `https://<domain>/ui`, unlock with the passphrase, and check the profiles list.

### 4. Create a token per agent

In the UI's API keys card, or on the host:

```bash
docker exec agentio agentio key create laptop --url https://<domain> --profiles gdrive/docunit,gmail/work
docker exec agentio agentio key create reporter --url https://<domain> --all --read-only
```

The token is printed once. Scope each key to what that agent needs; a read-only key cannot write through any profile it sees.

### 5. Set up an agent machine

Install the binary, then:

```bash
export AGENTIO_TOKEN='agio1.…'
agentio doctor          # reachability, token, lock state, in one line
agentio status          # the profiles this token may use
agentio gdrive list     # any service command, credentials served by the hub
```

No vault, no passphrase, nothing written to disk. `vault`, `key`, `daemon`, `reauth`, and profile changes are refused here; they belong on the hub.

### Day-to-day

- **Restart means locked** unless `AGENTIO_PASSPHRASE` is set on the container. `GET /health` stays 200 either way and says `locked: true|false`.
- **Rotate or revoke** from the UI or with `agentio key rotate|revoke` on the host. The old token stops working at once.
- **Reauth and new profiles** happen on the host with the CLI (`docker exec agentio agentio <service> profile add`); the paste-back OAuth flow works without a browser on the host.
- **Audit**: every credential call is one line on the container's stdout (`docker logs`), naming the key and profile.
- **Back up the volume**, not the env vars: the vault on the volume carries refreshed tokens and the keys. A version-keeping backup is worth having; a wrong write is undone by restoring the previous version of `vault.enc` and restarting.

## Notes

- Image name `plosson999/agentio-gateway` in `push.sh` is a legacy registry tag; the container runs **daemon**, not a removed `gateway` CLI.
- There is no WhatsApp pairing, `mcp teleport`, Cloudflare Tunnel, or Caddy mode in this image — those were undocumented/unshipped fiction and were removed.
