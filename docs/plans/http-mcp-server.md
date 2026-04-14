# Agentio HTTP MCP Server Plan (single-user)

## Goal

Expose the existing agentio MCP tools over Streamable HTTP so they're reachable
from containerized Claude Code, Claude Desktop, Cursor, and mobile web — without
the limitations of stdio transport. Single user (the operator), deployed the
same way as the gateway daemon.

This is a scoped-down alternative to [web-mcp-server.md](./web-mcp-server.md),
which adds multi-tenancy, web UI, and per-user OAuth. Start here; add that
later only if a second user materializes.

## Non-goals

- No web UI.
- No user store / allowlist / per-user isolation. There is exactly one user
  (the operator) and the only "identity" the server cares about is "did this
  request come from someone who knows the operator's API key".
- No remote profile provisioning. Adding a new Google/JIRA/GitHub profile
  still happens out-of-band — either by SSH-ing into the box and running
  `agentio gmail profile add` (browser flow on the server's network) or by
  running it locally and shipping the encrypted blob via
  `agentio config export` / `agentio config import`. The HTTP server never
  exposes service-level OAuth flows to clients.
- No per-user OAuth tokens or federated login (Google, GitHub-as-IdP, etc.).
  The only thing protecting `/authorize` is the operator's API key.
- No gateway supervisor (if you want WhatsApp/Telegram remotely, run
  `agentio gateway start` alongside the server; they share the config dir).
- No CORS. Browser-based MCP clients are not supported in v1. All current MCP
  clients of interest (Claude Desktop, Cursor, containerized Claude Code) are
  native and don't need CORS.

## Auth model (in scope, replaces the old "single bearer in env var" plan)

The server speaks the **MCP Authorization spec**: clients (Claude Code,
Cursor, etc.) discover OAuth metadata at
`/.well-known/oauth-protected-resource`, dynamically register, run an
authorization-code-with-PKCE flow against `/authorize`/`/token`, and
present the issued bearer on every `/mcp` request. From the client's
perspective this is exactly what every spec-compliant MCP client expects —
no special configuration, no manual token paste.

The trick is that the *human* side of `/authorize` is dead simple: a single
HTML page that asks for the **operator's API key** (one long random string,
not a per-request PIN). If the key matches, the server issues an auth code,
the client exchanges it for an access token, and the token gets cached by
the client for future runs.

- **API key source priority**: `--api-key <value>` flag → `AGENTIO_SERVER_API_KEY`
  env var → auto-generated at first boot and persisted into
  `config.server.apiKey` (mirrors how the gateway already manages
  `config.gateway.apiKey`).
- **API key is always printed at boot** to the server's terminal. On a
  headless deploy you read it from `agentio server logs` or the container
  logs.
- **Issued tokens are persistent** — stored in
  `~/.config/agentio/config.json` under `config.server.tokens` (or in
  `tokens.enc` under a `_server` slot — TBD during Phase 3). Surviving
  `agentio server stop` / `start` cycles is the whole point; no one wants
  to re-approve the OAuth flow every restart.
- **Token lifetime**: 30 days, **no refresh tokens**. After expiry the
  client re-runs the authorize flow once. Single user, restarts are rare,
  refresh tokens are extra protocol surface for no real benefit.
- **No rate limiting on `/authorize`**. The API key is long enough
  (~24 random bytes, base64url) that brute-force is not a credible threat.
- **Bind address defaults to `0.0.0.0`**, with `--host` to override. The
  server is intended to be reachable from other machines on the LAN /
  through Cloudflare Tunnel; the API key is the only gate, and it's
  sufficient for that purpose.
- **Token revocation**: `agentio server tokens list|revoke <id>|clear`.

## Architecture

```
┌──────────────────────────┐        ┌─────────────────────────┐
│ Claude Code (container)  │        │                         │
│ Claude Desktop           │──HTTPS▶│  agentio server start   │
│ Cursor                   │ bearer │  (Bun, :8787)           │
│ Mobile web               │        │                         │
└──────────────────────────┘        │  /mcp  ← Streamable HTTP│
                                    │  /health               │
                                    │                         │
                                    │  reads ~/.config/agentio│
                                    │  (same dir as CLI)      │
                                    └─────────────────────────┘
```

- **One process**: `agentio server start --foreground` runs a Bun HTTP server.
- **One config dir**: reads `~/.config/agentio/` (or `XDG_CONFIG_HOME`), exactly
  like the CLI. Profiles are added via SSH using existing `agentio <svc> profile
  add` commands. No config changes needed.
- **One bearer token**: set `AGENTIO_SERVER_TOKEN` in the environment. Every
  `/mcp` request must include `Authorization: Bearer <token>`.
- **Tool selection**: the server reuses `collectMcpTools()` to expose all
  services that have at least one profile configured. Clients pick which
  services they want via `?services=gmail:work,slack:team` on the URL (same
  shape as the current `agentio mcp serve` argv).
- **Deployment**: Docker image in the same shape as the gateway — Ubuntu base,
  fetches the agentio binary at container start, three TLS modes (Cloudflare
  Tunnel / Caddy+LE / plain HTTP).

## File layout

```
src/
├── commands/server.ts           # `agentio server` command group
├── server/
│   ├── daemon.ts                # Lifecycle (startServer, signal handling)
│   │                            #   — mirrors src/gateway/daemon.ts
│   ├── http.ts                  # Bun fetch handler + route table
│   ├── oauth.ts                 # OAuth endpoints: metadata, register,
│   │                            #   authorize (GET form + POST validate),
│   │                            #   token, bearer middleware
│   ├── oauth-store.ts           # Persistent storage for clients, codes,
│   │                            #   tokens; reads/writes config.server.*
│   └── mcp-http.ts              # Streamable HTTP MCP transport handler
├── types/server.ts              # ServerConfig + token/client types
└── mcp/server.ts                # MODIFIED — export buildProgram and
                                  #   executeCommand (collectMcpTools already
                                  #   exported from tools.ts) — DONE in Phase 1

docker/
├── Dockerfile                   # MODIFIED — parameterize CMD + HEALTHCHECK port
│                                #   so the same image can run gateway OR server
└── README.server.md             # Env vars + deployment notes
```

Total new code: ~6 source files + types + Dockerfile tweak. No cross-cutting
refactors. The OAuth implementation is hand-rolled (the SDK's auth helpers
are Express-bound and can't be used with Bun's fetch handler without
dragging in Express).

## Phased implementation

Each phase ships something runnable and testable on its own.

### Phase 1 — Extract reusable helpers + make stdout capture concurrency-safe

The existing stdio server has three pieces that must be reused:

- `buildProgram(services)` — builds a Commander program with only the requested
  service registrations.
- `collectMcpTools(program, service)` — reflects Commander commands into MCP
  tool definitions.
- `executeCommand(program, tool, input, profile)` — the argv rebuilding +
  stdout-capture wrapper that runs a CLI command in-process.

`collectMcpTools` is already exported from `src/mcp/tools.ts`. Two changes:

1. **Export** `buildProgram` and `executeCommand` from `src/mcp/server.ts` so
   both the stdio server and the HTTP server can call them.
2. **Rewrite `executeCommand`'s stdout capture** to be concurrency-safe. Today
   it swaps `console.log` and `process.stdout.write` per call and restores
   them in a `finally` — that's broken under concurrent HTTP requests because
   two in-flight calls would overwrite each other's capture functions and
   cross-contaminate output. Fix with `AsyncLocalStorage`:

   ```ts
   import { AsyncLocalStorage } from 'node:async_hooks';

   const captureContext = new AsyncLocalStorage<string[]>();

   // Patch ONCE at module init
   const origLog = console.log;
   const origWrite = process.stdout.write.bind(process.stdout);
   console.log = (...args: unknown[]) => {
     const chunks = captureContext.getStore();
     if (chunks) chunks.push(args.map(String).join(' '));
     else origLog(...args);
   };
   process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
     const chunks = captureContext.getStore();
     if (chunks) {
       chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
       return true;
     }
     return origWrite(chunk, ...rest as []);
   }) as typeof process.stdout.write;

   export async function executeCommand(...): Promise<string> {
     // ... build argv as today ...
     const chunks: string[] = [];
     await captureContext.run(chunks, () => program.parseAsync(argv));
     return chunks.join('\n');
   }
   ```

   `AsyncLocalStorage` propagates through `await`, so each concurrent
   invocation gets its own `chunks` array. No per-call monkey-patching. Works
   unchanged in stdio mode (one call at a time) and correctly in HTTP mode
   (multiple in flight).

**Test**: `bun run typecheck` passes. Existing `agentio mcp serve` still works
(regression test: use it from Claude Code as today). Add a unit test at
`src/mcp/server.test.ts` that runs two `executeCommand` calls concurrently
against a Commander program whose handlers `await` in the middle of their
work, and asserts each call sees only its own output. **This is the single
most important test in the whole plan** — it's the one bug that stdio mode
can't exercise and that will bite under any concurrent HTTP load. Don't skip
it.

### Phase 2 — `agentio server start` scaffolding

Mirror the gateway model exactly: foreground mode + optional systemd
integration. **No double-fork, no PID file** — the gateway doesn't use
those either; it relies on systemd for daemonization and `journalctl` for
logs. Stay consistent.

1. `src/types/server.ts` and `src/types/config.ts` extension:

   ```ts
   // src/types/server.ts
   export interface ServerConfig {
     apiKey?: string;
     port?: number;     // default 9999
     host?: string;     // default '0.0.0.0'
     // Phase 3 fields:
     // clients?: OAuthClient[];
     // tokens?: ServerToken[];
   }
   ```

   `Config` gains `server?: ServerConfig`, mirroring `gateway?: GatewayConfig`.

2. `src/server/daemon.ts` — `startServer()`:
   - Loads config, generates `apiKey` if missing
     (`srv_${randomBytes(24).toString('base64url')}`), persists via
     `saveConfig`.
   - **Always prints the API key to stdout at boot** so it shows up in
     `agentio server logs` / `journalctl` / `docker logs`.
   - Resolves `port` (default 9999) and `host` (default `0.0.0.0`) from
     CLI flags → env (`AGENTIO_SERVER_PORT`, `AGENTIO_SERVER_HOST`) →
     `config.server` → defaults.
   - `--api-key <value>` flag and `AGENTIO_SERVER_API_KEY` env override the
     stored key (without overwriting it). The override is in-memory only —
     the next plain `agentio server start` falls back to the stored key.
   - Starts a Bun HTTP server (`Bun.serve({ port, hostname, fetch })`) with
     `fetch` delegating to `src/server/http.ts`.
   - Signal handling: `SIGINT`/`SIGTERM` → log "shutting down…", call
     `server.stop()` (graceful, lets in-flight requests drain), then exit.
   - Stays alive with `await new Promise(() => {})`, exactly like
     `startGateway()`.

3. `src/server/http.ts` — minimal route table:
   - `GET /health` → `200 {"ok":true}`.
   - Anything else → `404 {"error":"not found"}`.
   - No auth, no MCP, no OAuth. That's all Phase 3 / Phase 4.

4. `src/commands/server.ts` — mirror `src/commands/gateway.ts`:
   - `start [--foreground] [--port <n>] [--host <h>] [--api-key <k>]`
   - `stop`, `restart`, `status`, `logs`, `install`, `uninstall`
   - The systemd integration (install/uninstall/stop/restart/logs via
     `journalctl`) is a copy-paste from the gateway commands with a
     different `SERVICE_NAME` constant. The differences are mechanical
     enough that it's fine to lift the helpers verbatim.

5. Register `registerServerCommands` in `src/index.ts`.

**Test**: `bun run typecheck` clean. `bun run dev server start --foreground`
prints the API key + listening URL, `curl http://localhost:9999/health`
returns `{"ok":true}`, Ctrl-C exits cleanly. (Don't bother with the
systemd path on macOS — it's Linux-only and the dev loop works through
`--foreground`.)

### Phase 3 — Hand-rolled MCP-spec OAuth

The goal of this phase: when you run

```
claude mcp add --scope local --transport http agentio \
  "http://localhost:9999/mcp?services=gchat:default,gmail:default"
```

…and then `claude`, Claude Code probes `/mcp`, gets a 401 with a
`WWW-Authenticate` header pointing to the resource metadata, walks the
OAuth dance, opens the browser to a "enter your agentio API key" page,
and on success caches a bearer token it'll use forever (well, 30 days).

#### 3a. Storage (`src/server/oauth-store.ts`)

Three persistent collections, all written into `config.server`:

```ts
interface OAuthClient {
  clientId: string;            // generated on /register
  clientName?: string;         // from DCR request, e.g. "Claude Code"
  redirectUris: string[];      // validated on /authorize and /token
  createdAt: number;
}

interface ServerToken {
  token: string;               // opaque, 32 random bytes base64url
  clientId: string;
  scope: string;               // mirrors the ?services= the client used at /authorize
  issuedAt: number;
  expiresAt: number;           // issuedAt + 30 days
}
```

Codes (the short-lived `?code=` Claude Code exchanges at `/token`) are
**in-memory only** — `Map<string, AuthCode>` keyed by code, with a 60s
TTL. They never need to survive a restart, since the whole flow takes
seconds.

```ts
interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;       // PKCE S256
  scope: string;               // services= captured at /authorize
  expiresAt: number;
}
```

The store exposes `loadClients/saveClient/findClient`,
`issueToken/findToken/revokeToken/listTokens`, and
`createCode/consumeCode` (consume = look up + delete).

#### 3b. Endpoints (`src/server/oauth.ts`)

All hand-rolled, all returning Web `Response` objects so they plug into
the Bun fetch handler from Phase 2 with no glue.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/.well-known/oauth-protected-resource` | RFC 9728 metadata: `{ resource, authorization_servers, scopes_supported, bearer_methods_supported }` |
| `GET`  | `/.well-known/oauth-authorization-server` | RFC 8414 metadata: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code"]`, etc. |
| `POST` | `/register` | RFC 7591 DCR: accepts `{ client_name, redirect_uris }`, persists an `OAuthClient`, returns `{ client_id, redirect_uris, client_id_issued_at }`. No `client_secret` (public client, PKCE-only). |
| `GET`  | `/authorize` | Renders an HTML page with a single password field ("Enter your agentio API key") and hidden inputs for `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, `scope`. The HTML is ~80 lines, served as a string literal — no template engine. |
| `POST` | `/authorize` | Validates the API key with `crypto.timingSafeEqual`. On success: generates a code, stores the AuthCode (with PKCE challenge + redirect_uri + scope), 302's to `redirect_uri?code=<code>&state=<state>`. On failure: re-renders the form with an error. |
| `POST` | `/token` | `grant_type=authorization_code` only. Validates: code exists + not expired, `client_id` matches, `redirect_uri` matches, `code_verifier` hashes (S256) to the stored `code_challenge`. Issues a `ServerToken`, returns `{ access_token, token_type: "Bearer", expires_in: 2592000, scope }`. Consumes the code. |

The metadata responses use the `host` and (HTTP/HTTPS) scheme of the
incoming request to construct absolute URLs — that way the same binary
works whether you hit it via `http://localhost:9999`,
`http://10.0.0.5:9999`, or `https://agentio.example.com` behind a TLS
proxy. Cache the parsed `Request.url` per request, build URLs from there.

#### 3c. Bearer middleware

A small helper used from `http.ts`:

```ts
async function requireBearer(req: Request): Promise<ServerToken | Response> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return unauthorized(req);
  const token = await findToken(auth.slice(7));
  if (!token || token.expiresAt < Date.now()) return unauthorized(req);
  return token;
}

function unauthorized(req: Request): Response {
  const metadataUrl = `${origin(req)}/.well-known/oauth-protected-resource`;
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
    },
  });
}
```

The `WWW-Authenticate: Bearer resource_metadata=...` header is what
triggers Claude Code's discovery → DCR → OAuth flow on the very first
request. Without it, Claude Code just shows a 401 error.

`/mcp` runs through `requireBearer`. `/health`, `/.well-known/*`,
`/register`, `/authorize`, and `/token` do not.

#### 3d. Token management subcommands

Add to `src/commands/server.ts`:

- `agentio server tokens list` — print issued tokens (id, client_name, issued, expires, last8).
- `agentio server tokens revoke <id>` — delete one token.
- `agentio server tokens clear` — delete all (forces every client to re-auth).

**Test**:
1. `bun run dev server start --foreground` → note the API key.
2. `curl -i http://localhost:9999/mcp` → 401 with `www-authenticate` header.
3. `curl http://localhost:9999/.well-known/oauth-protected-resource` →
   JSON with `authorization_servers` pointing back at the same origin.
4. From a browser, hit `/authorize?client_id=test&redirect_uri=http://example.com/cb&code_challenge=...&code_challenge_method=S256&response_type=code&state=xyz`.
   Submit with the wrong key → error. Submit with the right key → 302 to
   `example.com/cb?code=...&state=xyz`.
5. End-to-end: `claude mcp add ...` against the running server, `claude`,
   walk through the browser flow, confirm the access token gets stored
   and subsequent `/mcp` requests are authorized. (This step actually
   requires Phase 4 to be done — the `/mcp` handler has to do something
   useful — so the *real* end-to-end test is the Phase 4 acceptance test.)

### Phase 4 — Streamable HTTP MCP transport

1. `src/server/mcp-http.ts`:
   - Uses `WebStandardStreamableHTTPServerTransport` from
     `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` — this is
     the Web-standard variant (Request/Response/ReadableStream) that works
     natively with Bun's fetch handler. The Node/Express variant
     (`streamableHttp.js`) exists too but would need a shim.
   - Parses `?services=gmail:work,slack:team` via the existing
     `parseServiceProfiles()` from `src/mcp/server.ts`.
   - **Session lifecycle — this is the subtle bit.** The Streamable HTTP
     transport is session-oriented: the SDK maps an `mcp-session-id` header
     to a long-lived `Server` + `Transport` pair across `initialize`,
     `tools/list`, `tools/call`, `notifications/*`. Creating a new `Server`
     per HTTP request would fight the transport's session bookkeeping and
     break `initialize`/notification sequencing. Do this instead:

     - Maintain a `Map<sessionId, { server, transport, services, toolNames }>`
       at module scope.
     - On the first request of a session (no `mcp-session-id` header, or an
       `initialize` call), read `?services=` from the URL, build one
       Commander program + `collectMcpTools()` + `Server` instance, create a
       transport, register it in the map, and **freeze the service list for
       that session's lifetime**.
     - On subsequent requests for a known session, look up and reuse the
       existing `Server`/`Transport` pair. Ignore any new `?services=` —
       the session's service set is immutable once `initialize` has run.
     - On `DELETE /mcp` (or session close), dispose of the pair and remove
       it from the map.
     - Tool handlers on the `Server` **build a fresh Commander program per
       tool invocation** via `buildProgram()` (cheap — it's just object
       construction — and needed so mutable Commander state from a previous
       call can't leak into the next one). The `Server` itself is reused.
   - Wires `ListToolsRequestSchema` and `CallToolRequestSchema` handlers on
     each session's `Server` that delegate to `executeCommand()` — the same
     code path as stdio.
   - Keeps the `lastChecked` Map (gchat_list tracking from
     [commit c54d84a](../../)) at server-lifetime scope, keyed by
     **`sessionId:service:space`**. Keying by session prevents two
     concurrently-connected clients (e.g. Claude Desktop + Cursor) from
     resetting each other's "previously checked" markers. For a single-user
     deploy this is cheap insurance.
   - Mounts the transport at `GET / POST / DELETE /mcp`.
2. `src/server/http.ts` routes `/mcp` → `mcp-http.ts`, `/health` → ok, else 404.

Before writing code against the SDK, sanity-check the transport's expected
interaction shape — session id generation, whether the transport takes
ownership of the map or the app owns it, and exactly which method name to
call on `initialize`. (SDK symbol already verified:
`WebStandardStreamableHTTPServerTransport` is exported from
`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` in the
pinned `^1.29.0`.)

**Test**: point Claude Desktop at `https://<host>/mcp?services=gchat:me`, auth
with the bearer token, run "list gchat spaces", confirm it works end-to-end.

### Phase 5 — Docker + deployment

**Reality check on the current docker layout.** There is exactly one
`docker/Dockerfile` (the binary-based gateway image). Its entrypoint is
`docker/entrypoint-bin.sh` — a 27-line "fetch the release binary, exec
`$@`" script. The `CMD` is `["agentio", "gateway", "start", "--foreground"]`
and the `HEALTHCHECK` is hardcoded to `http://localhost:7890/health`. The
older `docker/entrypoint.sh` with Cloudflare Tunnel / Caddy+LE / plain HTTP
mode-switching is **legacy** — it is not wired up by the current
`Dockerfile` and runs against `bun run /app/src/index.ts`, not the release
binary. Don't copy-paste from it without reviving the source-based image.

Given that the two images only differ in `CMD`, `EXPOSE`, and `HEALTHCHECK`
port, **use a single Dockerfile** parameterized at run time rather than
adding a second one. Concretely:

1. Modify `docker/Dockerfile`:
   - Change `HEALTHCHECK` to use an env var the entrypoint can override,
     e.g. `CMD sh -c "curl -sf http://localhost:${PORT:-7890}/health || exit 1"`.
     (Keep the default at `7890` so existing gateway deploys are unchanged.)
   - Leave `CMD` as the gateway default; the server deploy overrides it with
     `docker run ... <image> agentio server start --foreground` (or a
     `command:` override in compose).
   - Optionally bump `EXPOSE` to list both `7890` and `8787`, or drop
     `EXPOSE` entirely (it's metadata, not enforcement).
2. `docker/README.server.md` documents required env vars for server mode:
   - **`AGENTIO_KEY`** — **this is the #1 thing that will trip you up.**
     `tokens.enc` is encrypted with a key derived from hostname+username on
     the machine where the profiles were added. Inside a container with a
     different hostname/user, decryption will silently fail and every
     tool call will return auth errors. You must either (a) seed profiles
     from inside the container and never move the config dir, or (b) export
     `AGENTIO_KEY` from the host where the profiles were added
     (`agentio config export` prints it) and inject it into the container.
     Put this at the top of the README, not buried in an env-var list.
   - `AGENTIO_SERVER_TOKEN` — bearer token clients must present. The
     server refuses to start if this is unset.
   - Optional: `PORT` (default 8787 for server, 7890 for gateway),
     `DOMAIN` + `CLOUDFLARE_TUNNEL_TOKEN` if you later add a TLS-mode
     entrypoint wrapper (out of scope for this plan — front the container
     with whatever your host already runs).
3. Provisioning docs: how to SSH into the container (or mount the config
   dir as a volume) and run `agentio gmail profile add` etc. to seed
   profiles.

**Test**: build the image locally, run it with a volume mount for
`~/.config/agentio` and `AGENTIO_SERVER_TOKEN=...`, hit `/mcp` from a
remote Claude client. TLS termination (Cloudflare Tunnel, Caddy, nginx,
etc.) is the host's problem, not this image's.

### Phase 6 — Docs

1. Update `CLAUDE.md`:
   - Add `Server` section to the commands reference.
   - Note the Docker deploy pattern.
2. `docker/README.server.md` covers deployment.

The Phase 1 `executeCommand` concurrency test is the one required unit test.
It covers the one failure mode that stdio `mcp serve` cannot exercise. Beyond
that, the server is a thin wrapper around already-tested code paths and is
easy to eyeball — the delta is just transport + bearer auth. No other unit
tests in v1.

## What's intentionally left out

These are candidates for a v2, not v1:

- **Per-URL tool filtering beyond `services`** — e.g., `?tools=gmail_send,gmail_list`.
  The current `services=` query is enough to carve out a working subset.
- **Token rotation / multiple tokens** — v1 has one shared token. Rotate by
  changing the env var and restarting.
- **Metrics / request logs beyond stderr** — the Bun server writes to the log
  file; that's enough for one user.
- **Rate limiting** — single-user deploys don't need it.
- **MCP-spec OAuth** — the MCP OAuth spec is still churning; bearer token works
  with every current MCP client that supports Streamable HTTP.
- **Web UI** — see [web-mcp-server.md](./web-mcp-server.md) for that path.

## Resolved questions

1. **Streamable HTTP transport in the SDK** — ✅ The pinned SDK ships
   `WebStandardStreamableHTTPServerTransport` from
   `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`.
   Bun-compatible (Web `Request`/`Response`). Phase 4 uses it.
2. **`executeCommand()` concurrency safety** — ✅ Done in Phase 1.
   AsyncLocalStorage refactor on `main` (well, on this branch).
3. **SDK auth helpers vs hand-rolled OAuth** — ✅ The SDK ships an
   `mcpAuthRouter` and per-endpoint handlers, **but they all
   `import express from 'express'`** and assume Express req/res. Using
   them with Bun's fetch handler would mean either bringing in Express as
   a dep + a fetch↔Express bridge, or wrapping each handler. Hand-rolling
   the OAuth endpoints in pure Bun fetch handlers is ~300-400 lines, has
   zero new deps, and gives us a custom `/authorize` HTML form for the
   API key gate. Phase 3 hand-rolls.
4. **OAuth flow shape** — ✅ Authorization Code with PKCE (S256), public
   client, no client secret. Dynamic Client Registration enabled (no
   pre-shared client_id needed). 30-day opaque bearer tokens, no refresh
   tokens. The single human-facing step is an HTML form asking for the
   operator's API key.

## Migration path to multi-tenant later

If you do eventually want to share the deploy with others, the path from this
v1 to the full [web-mcp-server.md](./web-mcp-server.md) plan is:

1. Add the AsyncLocalStorage refactor (Phase 1 of the other plan).
2. Add per-user config dirs and the user store.
3. Add web UI + login.
4. Replace the single bearer token with per-user tokens (or MCP-spec OAuth).
5. Add the gateway supervisor if WhatsApp/Telegram are needed per-user.

Nothing in this v1 plan blocks that migration — the HTTP server, bearer auth,
and MCP transport modules all stay; only the "single shared config dir"
assumption gets replaced.
