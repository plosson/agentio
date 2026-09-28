---
name: Spotify
slug: spotify
auth: OAuth (PKCE)
tagline: Search the catalog, manage playlists and your library, and control playback.
icon: 🎧
order: 185
---

## What you can do

- Search the catalog, and look up albums, artists, shows and audiobooks
- Create playlists and add or remove tracks
- Save and follow items in your library, and search it
- See your recently played tracks, and your top tracks and artists
- Control playback on an active device (needs Spotify Premium)

## Setup

Create your own app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), with the Web API and the redirect URI `http://127.0.0.1:3010/callback`. Copy its Client ID, then run:

```sh
agentio spotify profile add --client-id <id>
```

No client secret is needed. Add `--read-only` to request read access only, or `--no-browser` to paste the redirect URL back over SSH.

## Good to know

- Spotify ends a sign-in 6 months after it started. `agentio status` warns when fewer than 14 days remain; sign in again with `agentio profile reauth spotify`.
- An app in Development Mode serves at most 5 people, each added in the dashboard.
- Spotify's terms forbid using its content to train AI models.
