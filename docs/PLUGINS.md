# Service plugins

Last reviewed: 2026-09-27

In-tree services live under `src/plugins/`. The contract is documented in
[service-plugins.md](./service-plugins.md). Command help is generated from the
CLI itself (`agentio docs`, `agentio <service> --help`) — do not duplicate the
full command list here.

## Summary

| Service | Auth model | Notes |
| --- | --- | --- |
| Google (gmail, gdrive, gdocs, gcal, gtasks, gchat, gsheets, gslides, gscript) | Shared Google OAuth | Provider group under `src/plugins/google/` |
| GitHub | OAuth (bundled app) or token | |
| Jira / Confluence | Atlassian OAuth | Refresh-token rotation |
| Slack | Bot token or webhook | |
| Discourse | API key | |
| Dropbox | PKCE, user-owned app | No client secret |
| Revolut | Certificate + OAuth | Business API |
| SQL | Connection string | |
| Falco | Password + 2FA | Belgian invoicing |
| RSS | None | |
| **Spotify** | PKCE, user-owned app | No client secret; Development Mode limits |

## Spotify

Gives an agent access to a person's Spotify account: catalog search, playlists,
library, listening history / top items, and playback control.

### Create your own Spotify app

Development Mode apps are what every agentio user will have.

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**. You need Spotify Premium (the app owner must keep Premium).
2. Under **Redirect URIs**, add `http://127.0.0.1/callback` exactly as written, without a port. Spotify rejects `localhost`.
3. Under **Which API/SDKs are you planning to use**, select **Web API**.
4. Copy the **Client ID**. agentio does not need the client secret.
5. To let another person use the app, add their Spotify email under **User Management**. The limit is 5 people.

```bash
agentio spotify profile add --client-id <id>
# headless / paste flow:
agentio spotify profile add --client-id <id> --no-browser
# read scopes only (blocks writes and playback):
agentio spotify profile add --client-id <id> --read-only
```

When `--client-id` is omitted, the command prints the setup steps above and
prompts for the ID.

### Tokens and the 6-month limit

Since June 2026, Spotify refresh tokens expire **6 months after the user first
signed in**. Refreshing does not extend that window. `authorizedAt` is stored in
the vault; `agentio status` and `agentio doctor` warn when fewer than 14 days
remain and error after expiry. Re-authenticate with:

```bash
agentio profile reauth spotify
```

### Scopes and read-only

- Read scopes cover library, playlists, history, top items, and playback state.
- Write scopes cover library/playlist modification, follow, cover upload, and playback control.
- `--read-only` requests read scopes only. Write and playback commands fail with `READ_ONLY_PROFILE` before any request is sent.

### Library search and playlist find

The Web API cannot search *your own* library or playlists. `spotify library search`
and `spotify playlist find` fetch the relevant pages on every run and filter
locally. That can use many requests from the shared Development Mode quota; there
is no local cache in v1.

### Playback

Playback control needs Spotify Premium **and** an active device (desktop, phone,
web player, or a third-party daemon such as spotifyd). The API does not play audio
itself. Running spotifyd/librespot from agentio is out of scope for this plugin.

### Developer Terms

Spotify Developer Terms (v10+) forbid using Spotify content to **train** ML or AI
models. Sending metadata to an LLM at run time for a user-facing task is the
intended use of this plugin; do not use exports or command output as training
data.

### Quick command map

| Area | Examples |
| --- | --- |
| Account | `spotify account` |
| Catalog | `spotify search`, `spotify get`, `spotify album tracks`, `spotify artist albums`, `spotify show episodes`, `spotify audiobook chapters` |
| Playlists | `spotify playlist list\|find\|get\|items\|create\|update\|add\|remove\|reorder\|replace\|dedupe\|cover\|delete\|export` |
| Library | `spotify library list\|search\|save\|remove\|contains` |
| History | `spotify history`, `spotify top tracks\|artists` |
| Player | `spotify player status\|devices\|play\|pause\|next\|previous\|seek\|volume\|shuffle\|repeat\|queue\|transfer` |

Identifiers accept Spotify URIs, `open.spotify.com` URLs (including `/intl-xx/`
and `?si=`), and bare IDs when the command implies the type. Playlists and
devices can also be given by name. Pass `-` as an item argument to read URIs
from stdin (one per line).
