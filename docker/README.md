# Agentio daemon Docker

Runs the shipped CLI daemon (`agentio daemon start`), which serves the daemon API on port 7890. This image is the only supported way to run the daemon, and the vault hub that remote agents talk to.

## Build

From the repository root:

```bash
docker build -t agentio docker
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
| `AGENTIO_PASSPHRASE` | Vault passphrase. Required on first boot, since there is no terminal to prompt. Afterwards optional: when set, every restart comes up unlocked; when unset, the daemon starts locked and someone unlocks it at `/ui`. Anyone who can run the siteio or docker CLI on the host can read it back, so weigh that against unlocking by hand |
| `AGENTIO_KEEPALIVE_HOURS` | Hours between token keepalive passes (default: 168, one week; clamped to 1-336). `0` turns the loop off |
| `AGENTIO_TRUSTED_IP_HEADER` | Header the fronting proxy sets to the caller's address, used as the rate-limit key. Unset (default) keys on the socket peer, so a client-supplied header can never be trusted. Set to `cf-connecting-ip` behind Cloudflare, or `x-forwarded-for` behind a single proxy that appends. The last comma token is used, never the leftmost |

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

The proxy must set the caller's address in a header and `AGENTIO_TRUSTED_IP_HEADER` must name it, or the daemon's rate limits key on the socket peer (the proxy) and collapse every caller onto one bucket. A client-supplied header is never trusted without this env, so it cannot be spoofed to dodge the limits. Behind Cloudflare set `AGENTIO_TRUSTED_IP_HEADER=cf-connecting-ip`; behind a single appending proxy set `x-forwarded-for`. Open `https://<domain>/ui`, unlock with the passphrase, and check the profile list.

### One token per agent

In the UI's API keys card, or on the host:

```bash
docker exec agentio agentio key create laptop --url https://<domain> --profiles gdrive/docunit,gmail/work
docker exec agentio agentio key create reporter --url https://<domain> --all --read-only
docker exec agentio agentio key create workstation --url https://<domain> --all --can-manage-profiles
```

The token is printed once. Scope each key to what that agent needs: a read-only key cannot write through any profile it sees, and only a `--can-manage-profiles` key may change which profiles the vault holds.

### The agent machine

Install the binary, then:

```bash
agentio login https://<domain>   # prints a code; approve it in the hub UI, the token is stored in ~/.config/agentio/token
agentio doctor          # reachability, token, lock state, in one line
agentio status          # the profiles this token may use
agentio gdrive list     # any service command, credentials served by the hub
```

`login` needs no browser on the agent machine: open the printed URL from anywhere, check the code matches, pick the profiles, approve. A key made with `agentio key create` works the same way through `export AGENTIO_TOKEN='agio1.…'`, which also overrides a stored login. No vault and no passphrase on this machine. `vault`, `key`, `daemon` and `reauth` are refused here; they belong on the hub. Managing profiles is the exception, see Day-to-day.

### Day-to-day

- **Lock state after a restart** follows `AGENTIO_PASSPHRASE`, see the Environment table.
- **Rotate or revoke** from the UI or with `agentio key rotate|revoke` on the host. The old token stops working at once.
- **Reauth** happens on the host with the CLI (`docker exec agentio agentio profile reauth <service> [name]`); the paste-back OAuth flow works without a browser there.
- **Profiles** are added, renamed and removed on the host (`profile add <service>`, `profile rename <service> <old> <new>`, `profile remove <service> <name>`), or from an agent machine whose key has `--can-manage-profiles`: the OAuth or token dance runs there and the result is stored here. Such a key reaches exactly the profiles its allow-list names, plus any new name it creates; anything else answers "not found" and is left alone.
- **Audit**: every credential call and every remote save, rename or delete is one line on the container's stdout (`docker logs`), naming the key and profile.
- **Token keepalive**: once a week the daemon refreshes every profile whose access token has lapsed, so a refresh token nobody uses does not expire of disuse (Google drops one after six months idle, Atlassian after about ninety days). Unlocking the vault starts the loop and passes at once; locking stops it, so a hub left locked is not protected. One `keepalive pass` line per run says how many were refreshed, fresh, skipped and failed; a failure means that profile needs reauthenticating on the host. It does not defeat an absolute lifetime or a revocation.
- **Take care with the CLI on the host while the daemon is up.** Atlassian rotates its refresh token on every exchange, so a CLI command that touches an Atlassian profile can race a keepalive pass and leave one of the two tokens dead. The daemon serialises its own work; a second process is outside that. For hands-on work on the host, set `AGENTIO_KEEPALIVE_HOURS=0` and redeploy first, or press Lock in the UI for the duration.
- **Back up the vault file, not the env vars**: the file on the volume carries refreshed tokens and the keys, the env vars only the first-boot snapshot. Keep dated copies; a wrong write is undone by restoring the previous one and restarting.

  ```bash
  docker cp agentio:/data/.config/agentio/vault.enc ./vault-$(date +%F).enc      # backup
  docker cp ./vault-2026-09-12.enc agentio:/data/.config/agentio/vault.enc && docker restart agentio   # restore
  ```

## Notes

- Image name `plosson999/agentio-gateway` in `push.sh` is a legacy registry tag; the container runs **daemon**, not a removed `gateway` CLI.
- There is no WhatsApp pairing, `mcp teleport`, Cloudflare Tunnel, or Caddy mode in this image — those were undocumented/unshipped fiction and were removed.
