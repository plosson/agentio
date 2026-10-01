# TRD: Personal Todo service + AgentIO plugin

Status: Draft — **decisions locked** 2026-09-30 (CEST); no code written yet.  
Date: 2026-09-30 (CEST).  
Audience: Pierre (plosson).  
Spirit: same split as **Kite** — AgentIO plugin ↔ self-hosted web app with OAuth + API + iOS-friendly client.

## Decisions locked (2026-09-30)

1. **Greenfield** server in a new repo (e.g. `plosson/todo`, MIT) — **not** a fork. Stack: **Bun + Hono** (+ SQLite).
2. **Human auth on the PWA:** **Google OIDC**. AgentIO CLI keeps a separate **Kite-style device OAuth** flow (browser approve a code → vaulted bearer); do not conflate the two.
3. **No reminders, no push** in v1 — list + tags + checkoff is enough.
4. **Client = PWA only** for v1 (Safari → Add to Home Screen). **No** native iOS / TestFlight unless Pierre later asks; no Android.

---

## 1. Problem / goals / non-goals

### Problem

Pierre needs a **simple personal todo list** that:

- agents can drive via AgentIO (`agentio todo …`);
- he can open cleanly on iPhone via **PWA**;
- he owns end-to-end (self-hosted), with the same auth/API discipline as Kite.

Existing task products are either board/project-heavy (Vikunja, WeKan, Planka, Focalboard), desktop-first (Super Productivity), Nextcloud-tied (Nextcloud Tasks), gamified (Habitica), or file/Kanban without a first-class agent API (Tasks.md). Closest modern fits (ThingsToDo, OpenTask) still ship projects/areas/snooze/AI and lack Kite-style **device OAuth** for CLI profiles.

### Goals

1. **Tags-only organisation** — no projects, boards, priorities, areas, or kanban unless Pierre later opts in.
2. **Kite-shaped architecture** — one self-hosted **web app** exposes a **REST API**; AgentIO talks to that API; the iPhone client talks to the same API.
3. **AgentIO CLI** — `agentio todo add | rm | check | list` (and a few siblings), with `profile add` via browser/device OAuth, vaulted credentials, `--json`.
4. **iOS path** — installable **PWA** only for v1 (Add to Home Screen); **no Android**, no native/TestFlight unless later requested.
5. **Personal self-host** — single-user (or few users) Docker deploy; MIT or similarly permissive license preferred for a Pierre-owned repo.

### Non-goals (MVP)

- Multi-tenant SaaS, teams, sharing, comments.
- Recurrence engines, Gantt, CalDAV sync, email ingest.
- Reminders, due-date push, Web Push, APNs.
- Android client; native iOS / TestFlight (PWA only).
- Replacing Todoist/Things as a full GTD system.
- Bundling an MCP server in v1 (API + AgentIO is enough; MCP can follow).
- Porting or replacing any existing AgentIO service.
- Forking ThingsToDo / OpenTask / Vikunja as the product base.

---

## 2. User stories

### Pierre (human)

1. As Pierre, I open `https://todo.example.com` on my phone, Add to Home Screen, and see a clean list of open todos filtered by tag.
2. As Pierre, I tap to check off a todo; it disappears from the open list (or moves to “done”).
3. As Pierre, I add a todo with one or more tags (`errands`, `agentio`, `health`) without inventing a project.
4. As Pierre, I sign in once with **Google** and stay signed in on the PWA.
5. As Pierre, I revoke AgentIO device sessions from a “Where you are signed in” page if a laptop is lost.

### Agents (via AgentIO)

1. As an agent, I run `agentio todo profile add --url https://todo.example.com`, approve a code in the browser, and get a vaulted profile.
2. As an agent, I `agentio todo add "Buy milk" --tag errands --json` and get a stable id.
3. As an agent, I `agentio todo list --tag errands --open --json` and decide what to do next.
4. As an agent, I `agentio todo check tod_…` when done, or `agentio todo rm tod_… --confirm` to delete.
5. As an agent on a read-only profile, write commands are refused before any request (same host rule as Kite).

---

## 3. Architecture

```
┌─────────────────┐     device OAuth + REST      ┌──────────────────────────┐
│  agentio todo   │ ───────────────────────────► │  todo server (new repo)  │
│  plugin         │   Bearer token (vaulted)     │  API + web/PWA + auth    │
└─────────────────┘                              └────────────┬─────────────┘
                                                              │ same API
┌─────────────────┐     session cookie / Bearer              │
│  iOS Safari PWA │ ─────────────────────────────────────────┘
│  (or TestFlight │
│   native later) │
└─────────────────┘
```

| Piece | Role | Home |
|---|---|---|
| **Todo server** | Auth, SQLite, REST API, PWA UI | **New repo** e.g. `plosson/todo` (recommended) |
| **AgentIO plugin** | CLI + profile + device login client | `/workspace/agentio/src/plugins/todo/` |
| **Skill** | Auto-generated `agentio-todo` skill | `claude/skills/agentio-todo/` (via existing skill pipeline) |

### Why not “plugin-only”

A plugin alone cannot give Pierre an iPhone UI or a durable shared store. Kite’s value is the **pair**: server (open-artifact fork → Kite) + plugin. Todo should be the same split. The plugin stays thin (client + commands + device-auth), like `src/plugins/kite/`.

### Parallel to Kite / open-artifact

| Concern | Kite today | Todo proposal |
|---|---|---|
| Server | Fork of Open Artifact (fair-code SUL) | **Greenfield** MIT (or Apache-2.0) personal repo |
| Auth for CLI | `POST /api/auth/device` → browser approve → `POST /api/auth/device/token` | **Copy that shape** (same UX for Pierre and agents) |
| Credentials | `{ baseUrl, token, email, expiresAt }` in vault | Same shape |
| Profile add | Prompt URL → open verification URL → poll | Identical flow |
| Client surface | Documents / share / comments | Todos / tags / check |

Reuse **patterns** from open-artifact (device codes table, session revoke page, bearer for CLI), not the artifact document model.

---

## 4. Data model (minimal)

```
users
  id, email, created_at, …

todos
  id            text PK   -- e.g. tod_<nanoid>
  owner_id      text FK → users
  title         text NOT NULL
  notes         text NULL      -- optional; MVP can omit UI, keep column
  done_at       text NULL      -- ISO-8601; null = open
  created_at    text NOT NULL
  updated_at    text NOT NULL
  deleted_at    text NULL      -- soft delete optional; hard delete OK for MVP

tags
  id            text PK   -- e.g. tag_<nanoid>
  owner_id      text FK
  name          text NOT NULL  -- normalised lowercase slug or display name
  UNIQUE(owner_id, name)

todo_tags
  todo_id, tag_id
  PRIMARY KEY (todo_id, tag_id)
```

**Explicitly out of the model for MVP:** project_id, board_id, priority, due_at, recurrence, assignee, position/rank (unless needed for stable list order — then a simple `sort_key` integer is enough).

Optional phase-2 columns (not required to ship): `due_at`, `remind_at`.

---

## 5. CLI command sketch

Mirror Kite: service root `todo`, shared `--profile` / `--json`, profile subcommands via `createProfileCommands`.

```
agentio todo profile add [--url <url>] [--no-browser] [--json]
agentio todo profile list | remove | reauth …

agentio todo add <title> [--tag <name>]… [--notes <text>] [--json]
agentio todo list [--tag <name>]… [--open|--done|--all] [--json]
agentio todo get <id> [--json]
agentio todo check <id> [--json]          # mark done
agentio todo uncheck <id> [--json]        # reopen
agentio todo rm <id> --confirm [--json]
agentio todo tag list [--json]
agentio todo tag rm <name> --confirm [--json]   # optional; unused tags GC is fine
```

Examples:

```bash
agentio todo profile add --url https://todo.chuut.com
agentio todo add "Ship todo TRD" --tag agentio --json
agentio todo list --tag agentio --open --json
agentio todo check tod_abc123
agentio todo rm tod_abc123 --confirm
```

Plugin layout (mirror kite):

```
src/plugins/todo/
  index.ts          # defineServicePlugin
  client.ts         # REST client
  commands.ts       # registerCommands + profile add
  device-auth.ts    # copy kiteDeviceLogin shape against /api/auth/device*
  types.ts
  output.ts
```

---

## 6. API sketch

Base: `https://todo.example.com`. JSON. CLI uses `Authorization: Bearer <token>`. Browser uses session cookie after web sign-in.

### Auth (device / browser — Kite-compatible)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/device` | none | body `{ label }` → `{ deviceCode, userCode, verificationUrl, expiresInSeconds, intervalSeconds? }` |
| POST | `/api/auth/device/token` | none | body `{ deviceCode }` → pending / `{ token, expiresAt }` / denied |
| POST | `/api/auth/device/approve` | session | browser approves `userCode` |
| GET | `/api/auth/me` | bearer/session | `{ email, … }` |
| GET/DELETE | `/api/auth/sessions…` | session | revoke device/CLI sessions |

Web sign-in for humans can be email magic-link (like open-artifact) and/or OIDC; the **CLI must not** need a password pasted into the agent.

### Todos

| Method | Path | Notes |
|---|---|---|
| GET | `/api/todos` | query: `tag`, `status=open\|done\|all`, `limit`, `cursor` |
| POST | `/api/todos` | `{ title, tags?: string[], notes? }` |
| GET | `/api/todos/:id` | |
| PATCH | `/api/todos/:id` | `{ title?, notes?, tags?, done? }` |
| POST | `/api/todos/:id/check` | idempotent mark done |
| POST | `/api/todos/:id/uncheck` | |
| DELETE | `/api/todos/:id` | |

### Tags

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tags` | list with optional counts |
| DELETE | `/api/tags/:name` | optional; refuse if still attached or detach |

OpenAPI 3.x served at `/api/openapi` (nice-to-have MVP; required before polish).

---

## 7. Auth

**CLI / AgentIO:** device-code flow exactly as Kite (`agentio/src/plugins/kite/device-auth.ts` → open-artifact `device_codes` table). Verification URL must be same-origin as profile `baseUrl` (kite already enforces this).

**PWA / browser:** session cookie after email code or OIDC. Optional static API key is **not** preferred as the primary agent path (device OAuth is safer and matches AgentIO norms); a long-lived personal token minted in Settings can be a power-user escape hatch.

**Non-goals for auth MVP:** social login proliferation, passkeys (phase 2), Authelia-only (can add proxy-header later like OpenTask/ThingsToDo).

---

## 8. iOS vs PWA recommendation

### Recommendation: **PWA first**

For a tags-only personal list, a same-origin PWA can be “super clean”:

- Install via Safari Share → Add to Home Screen.
- Standalone display, light/dark, large tap targets, offline shell for cached UI (network for mutations is OK).
- One codebase with the API — no App Store, no Apple Developer Program required for MVP.
- Matches Kite’s “web UI + API” story (Kite itself has no native app).

### When native + TestFlight is better

Choose native (SwiftUI) + TestFlight-only personal distribution if any of these become true after PWA MVP:

1. **Reliable push** for reminders (iOS Safari web-push is improving but still weaker than APNs for “must not miss”).
2. Share Sheet / Shortcuts/App Intents depth beyond what the PWA + AgentIO already cover.
3. Offline-first sync that fights Safari storage eviction.

**OpenTask** already ships native iOS + Watch + APNs under AGPL — useful as a **reference**, not the default fork (see §9).

**No Android** — do not build or test Android; ignore Play distribution.

---

## 9. OSS inspiration comparison + recommended base

Research sources (fetched/scraped 2026-09-30): project READMEs, LICENSE files, Vikunja site, OpenTask docs/API, GitHub pages. Scores are **fit for AgentIO + simple list+tags + Kite-like auth**, not general quality.

| Project | URL | License | Stack | API | Auth | Tags | PWA/iOS | AgentIO fit (1–5) | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **ThingsToDo** | https://github.com/c00llin/thingstodo | **AGPL-3.0** | Go + SQLite + embedded SPA | REST + **MCP** (API key) | builtin / proxy / **OIDC** + API key | Yes (`#tag`) | **PWA** offline-first | **4** | Closest product UX; Things 3 projects/areas — heavier than needed; no device OAuth |
| **OpenTask** | https://github.com/trentmcnitt/opentask | **AGPL-3.0** | Next.js 16 + React 19 + SQLite | **Full REST**, OpenAPI 3.1, webhooks | NextAuth credentials, reverse-proxy header, bearer tokens | **Labels** yes | **PWA + native iOS + Watch** | **4** | Early release; projects/snooze/AI; best iOS reference; no device OAuth |
| **Vikunja** | https://vikunja.io / https://github.com/go-vikunja/vikunja | **AGPL-3.0** | Go + Vue | Mature REST + CalDAV | Local + **OIDC** | Yes | Web; mobile beta; 3rd-party PWA | **3** | Too much product surface (lists/kanban/gantt/teams) for “simple personal todo” |
| **Tasks.md** | https://github.com/BaldissaraMatheus/Tasks.md | **MIT** | SolidJS + Koa, markdown files | No first-class agent REST | Minimal (deploy-time) | Yes | **PWA** | **2** | Lovely Kanban-from-files; wrong model for AgentIO API |
| **Super Productivity** | https://github.com/johannesjo/super-productivity | **MIT** | Electron / Angular | Not a clean self-hosted multi-client API server | Local / sync providers | Yes | Desktop + limited mobile story | **2** | Timeboxing/Jira — wrong shape |
| **Nextcloud Tasks** | https://github.com/nextcloud/tasks | **AGPL-3.0** | Nextcloud app + CalDAV | CalDAV-centric | Nextcloud accounts | Limited | Via Nextcloud mobile | **2** | Requires full Nextcloud |
| **WeKan** | https://github.com/wekan/wekan | **MIT** | Meteor | REST exists | Various | Labels | Web | **1** | Kanban boards — overkill |
| **Planka** | https://github.com/plankanban/planka | **Fair-code** Community License | React + Node + Postgres | REST | Built-in | Labels | Web | **1** | Board product; fair-code limits; not simple list |
| **Focalboard** | https://github.com/mattermost/focalboard | MIT (Mattermost compiled) | Go + React | API | Mattermost-oriented | Properties | Web | **1** | Boards; project status/maintenance risk |
| **Habitica** | https://github.com/HabitRPG/habitica | **GPL-3.0** (+ asset licenses) | Large Node monolith | REST | Habitica accounts | Tags exist | Mobile apps exist | **1** | Gamification; not personal-minimal |

Also considered and deprioritised: todo.txt / Taskwarrior + web UIs (CLI-native but weak unified OAuth+PWA story), Teable / Affine (tables/docs, not todos), lists.sh, Anytype, Linear clones (overkill), Matt-PMCT/todo-me (MIT + REST + tags but Postgres+Redis and immature), T8D (MIT PWA sync, not Kite-auth shaped).

### Recommended base: **greenfield server + new AgentIO plugin**

**Recommendation: do not fork an OSS todo app as the production base.** Build a small server in a new repo (e.g. `plosson/todo`), and an AgentIO plugin `todo`.

**Why greenfield wins**

1. **Data model is tiny** — todo + tags; forking ThingsToDo/OpenTask/Vikunja means deleting or ignoring most of their product.
2. **Auth must match Kite** — device OAuth is already proven in open-artifact; grafting it onto NextAuth (OpenTask) or ThingsToDo OIDC/API-key is more work than implementing the known flow in a thin Hono/Chi/Fastify app.
3. **License control** — Pierre can ship **MIT/Apache-2.0** for a personal stack; AGPL forks are fine for self-host but constrain how the server is combined with other work and how plugins/docs are published.
4. **Kite precedent is “fork when the product is already the product.”** Open Artifact *was* already “publish HTML/MD + share + comments.” No OSS todo is already “tags-only list + device OAuth + AgentIO.” Inspiration yes; fork no.

**What to steal (read-only inspiration, not copy wholesale)**

- UX density / PWA offline ideas → **ThingsToDo**
- REST + OpenAPI + iOS companion patterns → **OpenTask**
- Device auth, sessions page, bearer CLI tokens → **open-artifact / Kite**
- Plugin mechanics → `src/plugins/kite/`

**Fallback if Pierre rejects greenfield**

1. **Fork OpenTask** if native iOS + TestFlight in month one is mandatory — then strip AI/projects where possible, add device OAuth, accept AGPL.
2. **Run ThingsToDo as-is** behind OIDC + API key and write only the AgentIO plugin (fastest spike, poorest long-term fit to “tags only” and device auth).

---

## 10. Phased delivery

### Phase 0 — Decide (this TRD)

- Confirm greenfield vs OpenTask fork vs ThingsToDo spike.
- Confirm PWA-only MVP vs early TestFlight.
- Name repo (`plosson/todo` vs `todoio` vs other) and public URL.

### Phase 1 — MVP (server + PWA + plugin)

1. Greenfield server (**Bun + Hono** + SQLite): users, todos, tags, **Google OIDC** for humans, **device OAuth** for AgentIO.
2. Minimal PWA: list open / done, add, check, tag filter, sign-in, sessions revoke.
3. AgentIO plugin: profile add (device flow), add/list/check/rm/get, `--json`, skill generation.
4. Docker Compose deploy next to Kite.

**Exit criteria:** Pierre uses it daily on iPhone PWA; an agent can add/check todos via AgentIO against the live instance.

### Phase 2 — Polish

- OpenAPI, better empty states, tag autocomplete, soft delete / undo.
- Read-only profiles / API-key scopes if hub remote mode needs them.

### Phase 3 — Only if needed (explicit ask)

- Native SwiftUI + TestFlight (only if PWA proves insufficient).
- MCP server (optional; AgentIO already covers agents).
- Import from ThingsToDo / OpenTask / Todoist export.
- Reminders / push (explicitly out of v1).

---

## 11. Open questions (resolved 2026-09-30)

| # | Question | Decision |
|---|---|---|
| 1 | Greenfield vs fork OpenTask / ThingsToDo spike? | **Greenfield** Bun + Hono (`plosson/todo` + AgentIO plugin) |
| 2 | PWA human auth? | **Google OIDC** (device OAuth remains for AgentIO) |
| 3 | Reminders / push in MVP? | **No** — list + tags + agent checkoff |
| 4 | PWA vs native? | **PWA only** for v1 |

Remaining (optional, not blocking MVP): domain hostname (`todo.chuut.com`?), allowlisted Google accounts, whether `due_at` exists as a silent field with no notifications.

---

## 12. Success criteria (for this TRD)

- [x] Written under `/workspace/agentio/docs/plans/todo-service-trd.md`
- [x] Research grounded in fetched READMEs/licenses/docs (ThingsToDo, OpenTask, Vikunja, Tasks.md, Super Productivity, Nextcloud Tasks, WeKan, Planka, Focalboard, Habitica)
- [x] Clear recommendation: **greenfield Bun+Hono + AgentIO plugin; Google OIDC; PWA only; no push**
- [x] Mirrors Kite integration style (profile add, device auth, CLI commands)

---

## Appendix A — Kite plugin touchpoints to mirror

| File | What to copy conceptually |
|---|---|
| `src/plugins/kite/index.ts` | `defineServicePlugin` + profile setup/createClient/reauthenticate |
| `src/plugins/kite/commands.ts` | `kiteProfileAdd` URL prompt + `signIn` + leaf commands with `--json` |
| `src/plugins/kite/device-auth.ts` | device start/poll, same-origin verification URL check, `deviceLabel()` |
| `src/plugins/kite/client.ts` | `normaliseBaseUrl`, bearer `raw()`, error mapping, `/api/auth/me` |
| `src/plugins/kite/types.ts` | `{ baseUrl, token, email, expiresAt }` |
| `claude/skills/agentio-kite/SKILL.md` | Generated skill shape for agents |

## Appendix B — Source notes (research)

- ThingsToDo README: AGPL-3.0; features tags, PWA, OIDC, API key, MCP; Go+SQLite single binary; LICENSE verified AGPL-3.0.
- OpenTask README + package.json: AGPL-3.0; Next.js 16 / React 19 / better-sqlite3 / next-auth; PWA + native iOS; REST + OpenAPI; labels via API docs.
- Vikunja: AGPL-3.0 (site + LICENSE); OIDC; REST; self-host or cloud.
- Tasks.md: MIT LICENSE; PWA; markdown lanes — no agent-grade auth API in README.
- Super Productivity: MIT; desktop productivity suite.
- Nextcloud Tasks: AGPL-3.0.
- WeKan: MIT; Kanban.
- Planka: fair-code Community License (not OSI).
- Focalboard: Mattermost MIT notice for compiled versions.
- Habitica: GPL-3.0 (LICENSE header).
- open-artifact/Kite: device_codes schema + fair-code SUL; AgentIO kite plugin implements device login against `/api/auth/device*`.
