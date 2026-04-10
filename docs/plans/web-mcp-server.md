# Agentio Web UI + HTTP MCP Server Plan

## Goal

Add a companion web UI + HTTP MCP server for agentio, deployable to a remote
VPS via Docker (mirroring the gateway pattern). Users sign in with Google /
GitHub OAuth (email-allowlisted), manage their own isolated profiles from the
browser, and generate MCP URLs that expose a chosen subset of their services /
profiles to MCP clients like Claude Desktop and Cursor.

## Requirements summary

These decisions came out of an interactive Q&A round and drive the design below.

| Topic                         | Decision                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Deployable unit               | Single combined server (web UI + MCP in one process).                                                                                |
| CLI entry point               | `agentio server start` subcommand.                                                                                                   |
| Web user authentication       | OAuth 2.0 via Google / GitHub.                                                                                                       |
| Access control                | Email allowlist (`AGENTIO_ALLOWED_EMAILS`).                                                                                          |
| User model                    | Per-user isolated profiles. No admin role; every authenticated user owns their own data.                                            |
| Storage layout                | Per-user config directories at `/data/users/<user-id>/` (reusing existing config-manager / token-store code).                       |
| Token encryption              | Derive per-user key from `AGENTIO_KEY` + user id (HKDF-SHA256).                                                                      |
| Web feature set (v1)          | Profile management + status dashboard. Message browsing / gateway controls deferred.                                                |
| Frontend stack                | Vanilla TypeScript + HTML (no framework, minimal footprint).                                                                         |
| Profile add flow              | Server-handled OAuth popup for OAuth services; web form for token-based services (Telegram bot, Slack token, Discourse, SQL, etc.). |
| WhatsApp pairing              | In-browser QR code.                                                                                                                  |
| Status dashboard              | Profile health grid (per-profile valid / expired / untested indicators).                                                             |
| Gateway relationship          | Server spawns a per-user gateway child process on demand.                                                                            |
| MCP scope                     | All CLI commands exposed as MCP tools.                                                                                               |
| MCP tool definition           | Auto-generated from Commander (reuse existing `src/mcp/tools.ts`).                                                                   |
| MCP tool execution            | In-process Commander execution (same as current `agentio mcp serve`).                                                               |
| MCP transport                 | Streamable HTTP.                                                                                                                     |
| MCP client authentication     | OAuth 2.0 per MCP spec (dynamic client registration, PKCE, discovery endpoints).                                                     |
| MCP link shape                | Public URL like `https://<host>/mcp?services=gmail:work,slack:team` — URL is just a config; auth is separate.                        |
| Remote OAuth redirects        | Fixed server HTTPS redirect (`https://<SERVER_DOMAIN>/oauth/<service>/callback`).                                                    |
| Deployment                    | Same pattern as the gateway: Docker image with Cloudflare Tunnel / Caddy+LE / plain HTTP modes.                                      |
| First-run bootstrap           | Fresh empty start. First allowlisted user to sign in simply creates their user row.                                                  |
| Per-user config isolation     | AsyncLocalStorage thread-through (not `process.env` mutation — see concurrency note below).                                          |

## Architecture overview

- **Single process**: `agentio server start --foreground` runs a Bun HTTP server that serves:
  - `/` — vanilla TS + HTML web UI (profile management + status dashboard).
  - `/auth/*` — Google / GitHub OAuth login for the web UI + MCP-spec OAuth for MCP clients.
  - `/oauth/<service>/callback` — fixed server redirect for per-service profile OAuth flows (Gmail, GDocs, GDrive, Google Chat, GitHub profile, JIRA profile).
  - `/api/*` — JSON API consumed by the web UI.
  - `/mcp` — Streamable HTTP MCP endpoint, scoped by `?services=gmail:work,slack:team`.
- **Per-user isolation**: Each authenticated user gets a config dir at `/data/users/<user-id>/`. All existing config / credential code reads the dir via `getConfigDir()`, which resolves from an AsyncLocalStorage context set per request. No `process.env` mutation.
- **Gateway processes**: The server spawns one child `agentio gateway start --foreground` process per user that has WhatsApp / Telegram profiles. Each child gets its own `XDG_CONFIG_HOME`, API key, and allocated port. The server reverse-proxies gateway API calls and the WhatsApp QR stream to the correct child.
- **Deployment**: Same Docker / Caddy pattern as `docker/Dockerfile` today — Ubuntu base, fetches the `agentio` binary at container start, three modes (Cloudflare Tunnel / Caddy + Let's Encrypt / plain HTTP).

## File layout

```
src/
├── commands/server.ts              # `agentio server start` command
├── server/
│   ├── daemon.ts                   # Lifecycle (start/stop, signal handling) — mirrors gateway/daemon.ts
│   ├── http.ts                     # Bun HTTP server, routing
│   ├── context.ts                  # AsyncLocalStorage { userId, configDir }
│   ├── auth/
│   │   ├── allowlist.ts            # Parse AGENTIO_ALLOWED_EMAILS env var
│   │   ├── web-oauth.ts            # Google / GitHub OAuth for web UI login
│   │   ├── session.ts              # Signed cookie sessions (HttpOnly, SameSite=Lax)
│   │   ├── mcp-oauth.ts            # MCP-spec OAuth: discovery, /authorize, /token, PKCE, bearer tokens
│   │   └── user-store.ts           # SQLite user table at /data/server.db
│   ├── users/
│   │   ├── config-dir.ts           # Resolve /data/users/<user-id>/, ensure exists
│   │   └── crypto.ts               # Derive per-user encryption key from AGENTIO_KEY + userId (HKDF)
│   ├── gateways/
│   │   └── supervisor.ts           # Spawn/track per-user gateway child processes; allocate ports; restart on crash
│   ├── api/
│   │   ├── profiles.ts             # GET/POST/DELETE /api/profiles
│   │   ├── status.ts               # GET /api/status — health grid for signed-in user
│   │   ├── oauth-flows.ts          # /api/profiles/:service/oauth/start + /oauth/:service/callback
│   │   └── whatsapp.ts             # GET /api/whatsapp/:profile/qr → SSE QR stream
│   ├── mcp/
│   │   └── http-server.ts          # Streamable HTTP transport; reuses collectMcpTools + buildProgram
│   └── web/
│       ├── index.html              # Single-page shell
│       ├── app.ts                  # Vanilla TS bootstrap, hash router, fetch wrappers
│       ├── views/
│       │   ├── login.ts            # Sign in with Google / GitHub
│       │   ├── dashboard.ts        # Profile health grid + inline MCP toggles + live URL preview
│       │   └── add-profile.ts      # Service picker → OAuth popup OR form
│       └── styles.css
├── auth/token-store.ts             # MODIFIED — key derivation accepts { userId, masterKey } in server mode
├── config/config-manager.ts        # MODIFIED — CONFIG_DIR → getConfigDir() reading AsyncLocalStorage
└── mcp/server.ts                   # MODIFIED — export buildProgram / executeCommand for reuse

docker/
├── Dockerfile.server               # New image for `agentio server`
├── entrypoint-server.sh            # Same pattern as entrypoint-bin.sh
└── README.server.md
```

## Phased implementation

### Phase 1 — Foundation (per-user isolation)

1. Add `src/server/context.ts` using `AsyncLocalStorage<{ userId: string, configDir: string }>`.
2. Refactor `src/config/config-manager.ts`: replace the `CONFIG_DIR` constant with a `getConfigDir()` function that checks AsyncLocalStorage first, else falls back to `XDG_CONFIG_HOME` (preserves CLI behavior).
3. Refactor `src/auth/token-store.ts`: encryption key derivation takes an optional `{ masterKey, userId }` path (HKDF-SHA256 with `info = "agentio-user-<id>"`) in addition to the existing machine-bound path. Server mode always uses the derived key.
4. Add `src/server/users/config-dir.ts` with `ensureUserDir(userId)` → `/data/users/<userId>/`.
5. Add unit tests proving two concurrent "requests" under different AsyncLocalStorage contexts read / write to different dirs without interference. **This resolves the concurrency concern around `process.env.XDG_CONFIG_HOME` mutation.**

### Phase 2 — HTTP server skeleton + web auth

1. `src/commands/server.ts` registers the `agentio server start` subcommand with `--foreground` and `--port` flags.
2. `src/server/daemon.ts` mirrors `gateway/daemon.ts` (signal handling, log file, boot sequence, auto-generated API key if missing).
3. `src/server/http.ts` sets up a Bun HTTP handler with routing.
4. `src/server/auth/allowlist.ts` parses `AGENTIO_ALLOWED_EMAILS` (comma-separated).
5. `src/server/auth/web-oauth.ts` implements Google + GitHub OAuth flows. Client credentials come from env: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. Redirects land on `/auth/<provider>/callback`.
6. `src/server/auth/session.ts` issues signed cookies (HMAC with `AGENTIO_KEY`).
7. `src/server/auth/user-store.ts` — SQLite-backed (at `/data/server.db`) user table: `(id, email, provider, createdAt)`.
8. Middleware: resolves session → looks up user → wraps request handler in `contextStorage.run({ userId, configDir }, handler)`.

### Phase 3 — Web UI (vanilla TS)

1. `src/server/web/index.html` shell with a `<div id="app">`.
2. `app.ts` hash-router with three routes: `#/login`, `#/dashboard`, `#/add/:service`.
3. `views/login.ts` — two buttons → `window.location = '/auth/google'` or `/auth/github`.
4. `views/dashboard.ts`:
   - Fetches `/api/status` and renders the profile health grid (grouped by service, with valid / expired / untested indicators).
   - Each profile row has an "Expose via MCP" checkbox.
   - A sticky footer shows the live-generated `https://<host>/mcp?services=<selected>` URL with a copy button and paste-ready JSON snippets for Claude Desktop and Cursor configs.
   - "Add profile" button → `#/add/:service`.
5. `views/add-profile.ts`:
   - For OAuth services, opens `/api/profiles/:service/oauth/start` in a popup.
   - For form-based services (Telegram bot, Slack, Discourse, SQL, JIRA token, GitHub PAT, RSS), renders a form with the required fields, POSTs to `/api/profiles/:service` which validates by pinging the service and saves.
6. Build step: `bun build src/server/web/app.ts --target=browser --outfile dist/server-web/app.js` during `bun run build`.

### Phase 4 — Profile OAuth flows (server-handled popups)

1. `src/server/api/oauth-flows.ts`:
   - `POST /api/profiles/:service/oauth/start` → generates state, stores `{ state, userId, service, profileName }` in an in-memory map (10 min TTL), returns the provider auth URL pointing at `/oauth/:service/callback`.
   - `GET /oauth/:service/callback` → looks up state, runs the existing service's token-exchange code under the user's AsyncLocalStorage context, saves via the existing `saveCredentials()`, then closes the popup with a `window.opener.postMessage`.
2. Gmail / GDocs / GDrive / GChat reuse `src/auth/oauth.ts` (swap redirect URI to `https://<SERVER_DOMAIN>/oauth/google/callback`).
   GitHub uses `src/auth/github-oauth.ts`. JIRA uses `src/auth/jira-oauth.ts`.
3. The deployment must set `AGENTIO_SERVER_DOMAIN=https://agentio.example.com` — the same domain Caddy terminates TLS on.

### Phase 5 — Per-user gateway supervisor

1. `src/server/gateways/supervisor.ts`:
   - Watches each user's config file for WhatsApp / Telegram profiles.
   - For users with such profiles, spawns `agentio gateway start --foreground` as a child process with `XDG_CONFIG_HOME=/data/users/<userId>`, `AGENTIO_GATEWAY_PORT=<allocated>`, and `AGENTIO_KEY=<derived-user-key>`.
   - Tracks child PIDs, restarts on crash (with exponential backoff).
   - Routes `/api/whatsapp/:profile/qr` and gateway-API calls to the correct child by reverse-proxying to `localhost:<user-port>`.
2. On server shutdown, SIGTERM all children, wait, then SIGKILL.

### Phase 6 — HTTP MCP endpoint

1. `src/server/mcp/http-server.ts`:
   - Implements Streamable HTTP transport from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
   - Routes: `GET / POST / DELETE /mcp`.
   - Parses `?services=gmail:work,slack:team` into `ServiceProfilePair[]` (reusing `parseServiceProfiles()` from `src/mcp/server.ts`).
   - Reuses `buildProgram()` + `collectMcpTools()` + the in-process `executeCommand()` capture logic from `src/mcp/server.ts`. No duplication — export those helpers.
   - Wraps tool execution in `contextStorage.run({ userId, configDir }, ...)` so the existing config / credential code automatically reads from the right per-user directory.
2. `src/server/auth/mcp-oauth.ts`:
   - `GET /.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource` (discovery).
   - `GET /authorize` — redirects MCP client to our Google / GitHub login, then back with an authorization code.
   - `POST /token` — exchanges code for a bearer token (signed JWT containing `userId`, `scope`, 1h expiry).
   - `POST /register` — dynamic client registration per MCP spec.
   - Middleware on `/mcp` validates the bearer token and resolves `userId`.

### Phase 7 — Docker + deployment

1. `docker/Dockerfile.server` — Ubuntu base, fetches `agentio` at start (same as gateway), `EXPOSE 8080`, `HEALTHCHECK /health`.
2. `docker/entrypoint-server.sh` — same Caddy / Cloudflare Tunnel / plain-HTTP modes as `entrypoint-bin.sh`, but for `agentio server start --foreground`.
3. `docker/Caddyfile` already exists; add a server variant with the right upstream.
4. `docker/README.server.md` documenting the env vars:
   - Required: `AGENTIO_KEY`, `AGENTIO_SERVER_DOMAIN`, `AGENTIO_ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
   - Optional: `DOMAIN` (Caddy), `CLOUDFLARE_TUNNEL_TOKEN` (tunnel mode), `SERVER_PORT` (default 8080).

### Phase 8 — Tests + docs

1. Unit tests: allowlist parsing, session signing / verification, per-user crypto (key derivation determinism), AsyncLocalStorage isolation, MCP URL parsing.
2. Integration test: spin up server, go through a mock OAuth login, add a mock profile, hit `/api/status`, call `/mcp` with a bearer token.
3. Update `CLAUDE.md` with the new `server` folder, commands, and deployment notes.

## Recommended implementation order

If staging the work, this order gets to end-to-end fastest:

1. Phases 1 + 2 + 3 — foundation, server skeleton, minimal web UI with login and an empty dashboard. Proves the per-user isolation model works.
2. Phase 4 — profile OAuth flows. Users can actually add Gmail / GDocs / GDrive / GitHub / JIRA from the browser.
3. Phase 6 — HTTP MCP endpoint. Delivers the other half of the goal.
4. Phase 7 — Docker. Makes it deployable.
5. Phase 5 — per-user gateway supervisor. Last because it's the most complex and gateway-dependent.
6. Phase 8 — tests + docs.

## Open concerns to validate before implementation

1. **Concurrent tool calls**: Resolved in Phase 1 via AsyncLocalStorage instead of `process.env.XDG_CONFIG_HOME` mutation. The existing `CONFIG_DIR` constant must become a function, and `token-store.ts` must resolve its path lazily. Flagging explicitly because this is a cross-cutting change.
2. **MCP spec OAuth churn**: The MCP OAuth spec is still evolving. Target the 2025-03-26 revision (currently supported by Claude Desktop and Cursor). The `mcp-oauth.ts` module is self-contained and easy to update if the spec changes.
3. **WhatsApp QR through the browser**: Baileys emits the QR as a data URL; the server streams it over SSE. The QR is short-lived and the user is already authenticated, so routing it through the server is acceptable.
4. **First-run UX**: Fresh empty start means the very first allowlisted user who signs in simply creates their user row. No "claim server" ceremony.
5. **No token revocation UI in v1**: Since MCP URLs are public configs and auth lifetime is controlled by MCP-OAuth session expiry (1h access + refresh tokens), users revoke by removing themselves from the allowlist or clearing sessions. A "sign out everywhere" button can be added later.
