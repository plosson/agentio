# Agentio daemon Docker

Runs the shipped CLI daemon (`agentio daemon start`), which serves the daemon API on port 7890. This image is the only supported way to run the daemon, and the vault hub that remote agents talk to.

## Build

From the repository root:

```bash
docker build -f docker/Dockerfile -t agentio .
```

## Run

Export the vault on the machine that has it:

```bash
agentio vault export --all
# prints AGENTIO_KEY=… and AGENTIO_CONFIG=…
```

Then:

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

The entrypoint fetches the agentio binary (pin with `AGENTIO_VERSION`), then starts the daemon. On the **first boot** of a volume, when `AGENTIO_KEY` and `AGENTIO_CONFIG` are set, it runs `agentio vault import` to create the vault from them. After that the volume is the source of truth and a restart never overwrites it.

The port is published on loopback because the daemon speaks plain HTTP and the passphrase travels in the unlock request. See "Where the TLS proxy runs" below before exposing it any wider.

## Environment

| Variable | Description |
|----------|-------------|
| `AGENTIO_KEY` | Encryption key from `agentio vault export`, used on first boot only |
| `AGENTIO_CONFIG` | Encrypted config from `agentio vault export`, used on first boot only |
| `AGENTIO_VERSION` | Optional: pin binary version (default: latest release) |
| `AGENTIO_PASSPHRASE` | Vault passphrase. Required on first boot, since there is no terminal to prompt. Afterwards optional: when set, every restart comes up unlocked; when unset, the daemon starts locked and someone unlocks it at `/ui` |

## Volumes / health

| Path | Description |
|------|-------------|
| `/data` | Vault + daemon state (`HOME` / `XDG_CONFIG_HOME`); the vault is `/data/.config/agentio/vault.enc` |

Health check: `GET http://localhost:7890/health`. It answers 200 whether the vault is locked or not, and the body carries `locked`, so a locked container is not killed before anyone can unlock it.

```bash
docker inspect --format='{{.State.Health.Status}}' agentio
docker logs -f agentio
```

## Running the vault hub on a VPS

This is the deployment the remote-vault design targets: this container on a public host, a TLS proxy such as siteio in front, and agents elsewhere holding one token each. Start the container as in "Run", then:

### Where the TLS proxy runs

The daemon always binds `0.0.0.0:7890` inside the container; what matters is how the host publishes it.

- **Proxy on the same host** (the common case): keep `-p 127.0.0.1:7890:7890` and point the proxy at `http://127.0.0.1:7890`.
- **Proxy on another machine**: publish with `-p 7890:7890`, allow inbound 7890 from the proxy's address only, for example `ufw allow from <proxy-ip> to any port 7890`, and point the proxy at `http://<vps-ip>:7890`.

The proxy must set `X-Forwarded-For`; the daemon's rate limits key on it. Open `https://<domain>/ui`, unlock with the passphrase, and check the profile list.

### One token per agent

In the UI's API keys card, or on the host:

```bash
docker exec agentio agentio key create laptop --url https://<domain> --profiles gdrive/docunit,gmail/work
docker exec agentio agentio key create reporter --url https://<domain> --all --read-only
```

The token is printed once. Scope each key to what that agent needs; a read-only key cannot write through any profile it sees.

### The agent machine

Install the binary, then:

```bash
export AGENTIO_TOKEN='agio1.…'
agentio doctor          # reachability, token, lock state, in one line
agentio status          # the profiles this token may use
agentio gdrive list     # any service command, credentials served by the hub
```

No vault, no passphrase, nothing written to disk. `vault`, `key`, `daemon`, `reauth`, and profile changes are refused here; they belong on the hub.

### Day-to-day

- **Lock state after a restart** follows `AGENTIO_PASSPHRASE`, see the Environment table.
- **Rotate or revoke** from the UI or with `agentio key rotate|revoke` on the host. The old token stops working at once.
- **Reauth and new profiles** happen on the host with the CLI (`docker exec agentio agentio <service> profile add`); the paste-back OAuth flow works without a browser there.
- **Audit**: every credential call is one line on the container's stdout (`docker logs`), naming the key and profile.
- **Back up the vault file, not the env vars**: the file on the volume carries refreshed tokens and the keys, the env vars only the first-boot snapshot. Keep dated copies; a wrong write is undone by restoring the previous one and restarting.

  ```bash
  docker cp agentio:/data/.config/agentio/vault.enc ./vault-$(date +%F).enc      # backup
  docker cp ./vault-2026-09-12.enc agentio:/data/.config/agentio/vault.enc && docker restart agentio   # restore
  ```

## Notes

- Image name `plosson999/agentio-gateway` in `push.sh` is a legacy registry tag; the container runs **daemon**, not a removed `gateway` CLI.
- There is no WhatsApp pairing, `mcp teleport`, Cloudflare Tunnel, or Caddy mode in this image — those were undocumented/unshipped fiction and were removed.
