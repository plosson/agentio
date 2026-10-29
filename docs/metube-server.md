# A MeTube server for `agentio metube`

`agentio metube` drives a [MeTube](https://github.com/alexta69/metube) server: yt-dlp and ffmpeg run there,
agentio only sends links and fetches the finished files. MeTube has no login, so on the internet it needs a
proxy in front that asks for one. This compose file puts Caddy with HTTP basic auth in front of MeTube; the
same credentials work in a browser and for agentio (`Authorization: Basic`).

```yaml
services:
  auth:
    image: caddy:2-alpine
    restart: unless-stopped
    environment:
      METUBE_USER: ${METUBE_USER:?set in .env}
      METUBE_PASSWORD_HASH: ${METUBE_PASSWORD_HASH:?set in .env}
    configs:
      - source: caddyfile
        target: /etc/caddy/Caddyfile
    depends_on: [metube]
  metube:
    image: ghcr.io/alexta69/metube:latest
    restart: unless-stopped
    environment:
      DELETE_FILE_ON_TRASHCAN: "true"   # removing a finished download deletes its file
    volumes:
      - downloads:/downloads
configs:
  caddyfile:
    content: |
      :8080 {
        basic_auth {
          {$$METUBE_USER} {$$METUBE_PASSWORD_HASH}
        }
        reverse_proxy metube:8081
      }
volumes:
  downloads:
```

`.env` holds the user and a bcrypt hash of the password, never the password itself:

```sh
HASH=$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$PASSWORD")
printf 'METUBE_USER=me\nMETUBE_PASSWORD_HASH=%s\n' "$(printf %s "$HASH" | sed 's/\$/$$/g')" > .env
```

With [siteio](https://github.com/plosson/siteio), the public URL goes to the `auth` service on port 8080:

```sh
siteio apps create metube --compose-file docker-compose.yml --env-file .env --service auth -p 8080
siteio apps set metube -d metube.example.com
siteio apps deploy metube
```

Then, wherever agentio runs:

```sh
agentio metube profile add --url https://metube.example.com --username me   # asks for the password
agentio metube get "https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

## Things to know

- **YouTube and datacenter IPs.** YouTube often answers servers in a datacenter with "Sign in to confirm
  you're not a bot", and the download fails. A server on a residential connection avoids it; so does giving
  MeTube cookies from a YouTube account (see MeTube's wiki), at the risk of that account.
- **One entry per link.** MeTube keys downloads by the video's page URL, so getting the same link again (say as
  audio after video) replaces the earlier entry in its list. A file kept with `--keep` stays on disk but drops
  out of `list`.
- **Fake-IP proxies.** MeTube refuses links that resolve to private addresses. Behind a Fake-IP DNS proxy, set
  `ALLOW_PRIVATE_ADDRESSES=true` on the `metube` service.
