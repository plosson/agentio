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
- No user login / OAuth / allowlist / user store.
- No per-user isolation, AsyncLocalStorage, or key-derivation refactor.
- No gateway supervisor (if you want WhatsApp/Telegram remotely, run
  `agentio gateway start` alongside the server; they share the config dir).
- No MCP-spec OAuth (Dynamic Client Registration, PKCE, `/authorize`, `/token`).
  A single shared bearer token in an env var is enough for one user.

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
├── commands/server.ts           # `agentio server start` command
├── server/
│   ├── daemon.ts                # Lifecycle (start/stop, signal handling, logs)
│   │                            #   — mirrors src/gateway/daemon.ts
│   ├── http.ts                  # Bun HTTP server + routing + bearer middleware
│   └── mcp-http.ts              # Streamable HTTP MCP transport handler
└── mcp/server.ts                # MODIFIED — export buildProgram, collectMcpTools,
                                  #   executeCommand so mcp-http.ts can reuse them

docker/
├── Dockerfile.server            # New image (copy Dockerfile.gateway, swap binary args)
├── entrypoint-server.sh         # Same Caddy/Tunnel/HTTP modes as entrypoint-bin.sh
└── README.server.md             # Env vars + deployment notes
```

Total new code: ~4 source files + docker assets. No cross-cutting refactors.

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

Two changes:

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
(regression test: use it from Claude Code as today). Add a tiny unit test that
runs two `executeCommand` calls concurrently and asserts their outputs don't
interleave.

### Phase 2 — `agentio server start` scaffolding

1. Copy `src/gateway/daemon.ts` to `src/server/daemon.ts` and adapt:
   - Log file at `~/.config/agentio/server.log`.
   - PID file at `~/.config/agentio/server.pid`.
   - Foreground mode (just runs), background mode (double-fork like the gateway).
   - Signal handling: SIGTERM / SIGINT → graceful shutdown.
2. `src/commands/server.ts`: new `agentio server` command group with:
   - `start [--foreground] [--port <n>]` (default port 8787)
   - `stop`
   - `status`
   - `logs [--follow] [--lines N]`
   - Mirrors the shape of `agentio gateway *` so it's familiar.
3. Register the command in `src/index.ts`.
4. For now, `start` just opens an empty Bun HTTP server with `/health` returning
   `{ ok: true }`.

**Test**: `agentio server start --foreground`, curl `/health`, SIGTERM, confirm
clean shutdown. `agentio server status` reports running / not running.

### Phase 3 — Bearer token middleware

1. `src/server/http.ts`:
   - Reads `AGENTIO_SERVER_TOKEN` from env at startup. If missing, log a warning
     and refuse to start (fail-fast — no accidentally-open deploys).
   - Middleware that rejects any `/mcp` request without
     `Authorization: Bearer <AGENTIO_SERVER_TOKEN>` as 401.
   - Constant-time comparison (`crypto.timingSafeEqual`) to avoid timing leaks.
2. `/health` stays unauthenticated so load balancers can probe it.

**Test**: curl `/mcp` without header → 401, with wrong token → 401, with right
token → (still a stub, but reaches the handler).

### Phase 4 — Streamable HTTP MCP transport

1. `src/server/mcp-http.ts`:
   - Uses `WebStandardStreamableHTTPServerTransport` from
     `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` — this is
     the Web-standard variant (Request/Response/ReadableStream) that works
     natively with Bun's fetch handler. The Node/Express variant
     (`streamableHttp.js`) exists too but would need a shim.
   - Parses `?services=gmail:work,slack:team` via the existing
     `parseServiceProfiles()` from `src/mcp/server.ts`.
   - On each request:
     - Builds a fresh Commander program via `buildProgram()`.
     - Collects tools via `collectMcpTools()`.
     - Creates an MCP `Server` instance with `tools: {}` capability.
     - Wires `ListToolsRequestSchema` and `CallToolRequestSchema` handlers that
       delegate to `executeCommand()` — the same code path as stdio.
     - Keeps the `lastChecked` Map (gchat_list tracking from
       [commit c54d84a](../../)) at server-lifetime scope, keyed by
       `service:space`.
   - Mounts the transport at `GET / POST / DELETE /mcp`.
2. `src/server/http.ts` routes `/mcp` → `mcp-http.ts`, `/health` → ok, else 404.

**Test**: point Claude Desktop at `https://<host>/mcp?services=gchat:me`, auth
with the bearer token, run "list gchat spaces", confirm it works end-to-end.

### Phase 5 — Docker + deployment

1. `docker/Dockerfile.server`: copy `docker/Dockerfile.gateway`, swap the entrypoint.
2. `docker/entrypoint-server.sh`: copy `docker/entrypoint-bin.sh` (or whichever
   the gateway uses), swap the command from `gateway start` to `server start`.
   Keep the three-mode logic (Cloudflare Tunnel / Caddy+LE / plain HTTP).
3. `docker/README.server.md` documents required env vars:
   - `AGENTIO_KEY` — machine-bound key override (same as gateway; needed so the
     server can read the encrypted tokens from `tokens.enc`).
   - `AGENTIO_SERVER_TOKEN` — bearer token clients must present.
   - Optional: `DOMAIN`, `CLOUDFLARE_TUNNEL_TOKEN`, `SERVER_PORT`.
4. Provisioning docs: how to SSH into the container (or mount the config dir as
   a volume) and run `agentio gmail profile add` etc. to seed profiles.

**Test**: build the image locally, run it with a volume mount for `~/.config/agentio`,
hit `/mcp` from a remote Claude client over Cloudflare Tunnel.

### Phase 6 — Docs

1. Update `CLAUDE.md`:
   - Add `Server` section to the commands reference.
   - Note the Docker deploy pattern.
2. `docker/README.server.md` covers deployment.

No unit tests in v1 — the server is a thin wrapper around already-tested code
paths. If the stdio `mcp serve` works, the HTTP one does too; the delta is just
transport + bearer auth, both of which are small and easy to eyeball.

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

1. **Streamable HTTP transport in the SDK** — ✅ resolved. The pinned SDK
   version ships both `streamableHttp.js` (Node/Express) and
   `webStandardStreamableHttp.js` (Web-standard, Bun-compatible). Phase 4 uses
   the latter.
2. **`executeCommand()` concurrency safety** — ✅ resolved. The existing
   per-call monkey-patching of `console.log` / `process.stdout.write` is
   confirmed unsafe under concurrent requests (the second call's swap would
   overwrite the first call's capture closure). Phase 1 rewrites it using
   `AsyncLocalStorage` — globals are patched once at module init and each
   invocation runs inside its own context with its own chunks array.
3. **Cloudflare Tunnel vs Caddy+LE default** — deployment preference, not a
   blocker. Reuse whatever the existing gateway Docker image does.

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
