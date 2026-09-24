# Bun → Go migration playbook (agent-followable)

**You are an agent porting AgentIO.** Follow this document + [ARCHITECTURE.md](./ARCHITECTURE.md). Do not invent a thinner Go-only redesign. Track command parity in [COVERAGE.md](./COVERAGE.md).

Related: [issue #85](https://github.com/plosson/agentio/issues/85) (feasibility) · [PR #86](https://github.com/plosson/agentio/pull/86) (`go-port/skeleton`).

---

## 1. Goal & non-goals

### Goal

Strangler-fig port of the **domain model + boundary signatures + CLI parity**, service-by-service:

1. Keep Bun vault wire format unlockable.
2. Mirror Bun ownership: core = vault/daemon/profile CRUD; service = Setup + API.
3. Reach leaf-command parity per service (see COVERAGE.md) before claiming it.

### Non-goals

- **WhatsApp** — deferred (issue #84 / whatsmeow later; do not start).
- **`AGENTIO_PLUGIN_PATHS` / external TS plugins** — out of scope for this port.
- **Merging to `main`** — never, until Pierre explicitly says merge.
- **Hex-Rays / decompilation** of anything — forbidden.
- Big-bang rewrite of all 20 Bun services in one PR.
- Changing vault crypto params or credential JSON key shapes without a migration plan.

---

## 2. Invariants (never violate)

- [ ] Port **DOMAIN MODEL** and **BOUNDARY SIGNATURES** first, not “just features.”
- [ ] Go layout idioms: `cmd/`, `internal/`. Bun modularity: **one package per service** under `internal/services/<id>/`.
- [ ] **Core owns:** vault crypto, `VaultContents` shape, daemon, profile CRUD (`SaveProfile` / `DeleteProfile` / `RenameProfile` / `ChooseProfileName` / `ListProfileRefs` / `ResolveProfile` / `AddProfileFromPlugin`), top-level `agentio profile`.
- [ ] **Service owns:** `Setup` (OAuth) returning credentials + `suggestedProfileName`, API client methods, service CLI for **API cmds only**.
- [ ] **Service MUST NOT:** write vault crypto, implement profile CRUD, duplicate refresh outside shared lifecycle.
- [ ] Shared **CredentialLifecycle** / `getFreshCredentials`-equivalent **before** any long-lived API use beyond one-shot smoke.
- [ ] Never claim Bun command surface in `Description()` until those cmds exist (fix Description overclaim — see COVERAGE.md).
- [ ] Always work on `go-port/*` branches; never merge to `main` without explicit ask.
- [ ] Push only to **`plosson/agentio`** (plosson GitHub account).

### Do

- Read ARCHITECTURE.md boundary tables before coding.
- Register every service via `service.Default.MustRegister` in `internal/cli/register.go`.
- Persist tokens only through `profile.SaveProfile` / host paths.
- Update COVERAGE.md + this Progress log in the same PR.

### Don't

- Put `SaveProfile` / vault `Encrypt*` inside `internal/services/*`.
- Hardcode `switch service { case "gmail": … }` for profile add — use `Registry.Find`.
- Copy Bun’s `src/` tree literally under `go/src/`.
- Mark a command `parity` without §6 checklist complete.

---

## 3. Bun → Go contract map

Full tables: **[ARCHITECTURE.md](./ARCHITECTURE.md)**. Summary agents must replicate for every new service:

### ServicePlugin + profile-host sequence

```
agentio profile add <id> [--profile] [--read-only]
        │
        ▼
cli/profile.go  →  service.Default.Find(id)
        │
        ▼
profile.AddProfileFromPlugin(ctx, store, plugin, SetupOptions)
        │
        ├─► plugin.Setup(ctx, opts)  →  SetupResult{Credentials, SuggestedProfileName, Info?}
        │         (SERVICE: OAuth only — NO vault write)
        │
        └─► profile.PersistSetupResult
                  ChooseProfileName → SaveProfile  (CORE: vault write)
```

Numbered steps (copy for each new service):

1. Implement `service.ServicePlugin` in `internal/services/<id>/` (`ID`, `DisplayName`, **honest** `Description`, `Setup`).
2. `Setup` returns credentials map matching **Bun vault wire keys** (Gmail snake_case OAuth; Jira camelCase `accessToken`/`refreshToken`/`expiryDate`/`cloudId`/`siteUrl`).
3. `service.Default.MustRegister(New())` in `internal/cli/register.go`.
4. Thin `internal/cli/<id>.go` for API commands; profile `add|list|…` are shims calling shared profile helpers — same as Bun `createProfileCommands` / `addProfileWithSetup`.
5. API cmds resolve profile via `profile.RequireProfile` / `ResolveProfile`, then **shared getFreshCredentials** (Phase 1), then client call.
6. Do **not** touch `internal/vault` crypto or profile CRUD when adding the service.

### Auth refresh (Bun reference — implement in Phase 1)

| Bun | Go target |
|-----|-----------|
| `src/auth/refresh.ts` `getFreshCredentials` | shared helper (e.g. `internal/auth` or `internal/profile` + lifecycle registry) |
| `CredentialLifecycle` on plugin (`applies` / `isStale` / `refresh` / `secretFields`) | interface + register Google snake + Jira |
| persist via `setCredentials` **before** API use | vault update of credentials map for that profile |
| serialize concurrent refresh per `service/profile` | mutex/singleflight per key (Atlassian rotation) |
| `REFRESH_BUFFER_MS` = 5m | same default |

---

## 4. Migration phases (ordered)

### Phase 0 — Foundations freeze

**Done when:**

- [x] Vault wire-compat tests (Bun fixture decrypt) present under `go/testdata/`
- [x] Profile store APIs Bun-named (`SaveProfile`, …) in `internal/profile`
- [x] `ServicePlugin` + `Registry` in `internal/service`
- [x] Daemon `GET /health`
- [x] ARCHITECTURE.md accurate
- [ ] Description() strings narrowed to implemented cmds only (fix remaining overclaim)
- [ ] This playbook + COVERAGE.md on branch

**Exit:** `cd go && go test ./...` green; no service package writes vault crypto.

### Phase 1 — Auth lifecycle (P0) ← **next recommended slice**

- [ ] Shared `getFreshCredentials(service, profile, opts)` mirroring Bun: load → lifecycle → refresh if stale/force → **persist before return**
- [ ] Google snake `CredentialLifecycle` (Gmail vault keys)
- [ ] Jira `CredentialLifecycle` (refresh-token rotation; serialize per profile)
- [ ] Wire Gmail/Jira API cmds through it (including existing smoke)
- [ ] `agentio profile reauth <service> [name]` + plugin reauthenticate hooks
- [ ] Tests: stale→refresh→persisted; force refresh; missing credentials error shape

**Exit:** long-lived API calls never use expired access tokens without attempting refresh+persist; COVERAGE shared lifecycle row updated.

### Phase 2 — Profile CLI parity

- [ ] `--read-only` on per-service `profile add` shims (match Bun)
- [ ] `profile update` (`--read-only` / `--no-read-only`) top-level and/or per-service
- [ ] Per-service `rename` / `remove` shims matching Bun `createProfileCommands`
- [ ] Top-level `profile reauth` already from Phase 1

**Exit:** profile UX matches Bun for gmail+jira for add/list/update/rename/remove/reauth.

### Phase 3 — Per-service command port (strangler)

For **each** service, run **§5** playbook.

**Order:**

1. **Jira** (small surface — finish missing API cmds)
2. **Gmail read** (`list`, `get`, `search`, labels/filters reads, attachment)
3. **Gmail write** (`send`, `draft`, archive/mark/label/filters writes)
4. Other Bun plugins later (only with Pierre direction) — still one service per slice

**Exit per service:** §5 Definition of Done.

### Phase 4 — Daemon/gateway parity

Port Bun daemon routes/keepalive as needed (`src/daemon/*`). Start from health → credential API → keepalive. Document gaps; do not claim parity early.

### Phase 5 — Cutover / dual-run validation

Document dual-run / dispatcher strategy from #85. **Do not auto-merge.** Pierre decides cutover.

---

## 5. Per-service port playbook (THE checklist)

For each service id (e.g. `jira`, `gmail`):

1. **Inventory Bun commands** — table: CLI path, flags, purpose, auth, write-gated? Seed/update COVERAGE.md.
2. **Map domain types** — credentials shape, profile meta, OAuth scopes (match vault wire).
3. **Implement/verify ServicePlugin** — `Name`/`ID`/`DisplayName`/`Description` **honest**/`Setup`.
4. **Register** in `service.Registry` via `register.go`.
5. **Wire lifecycle refresh BEFORE** any API cmd beyond intentional one-shot smoke.
6. **Port commands** in dependency order (read → write → bulk). For **EACH** command:
   - Match Bun CLI path and **flag names** unless Go idiom forces alias — document alias in COVERAGE notes
   - Call shared `ResolveProfile` / `getFreshCredentials` path
   - `enforceWriteAccess` equivalent if Bun gates writes
   - Tests: unit for client; golden/help for cobra flags if feasible
   - Update COVERAGE.md row → `parity`
7. **Profile shims:** `<svc> profile add|list|update|rename|remove` as thin wrappers like Bun.
8. **Update** ARCHITECTURE.md (if new boundaries) + this Progress log (§10).
9. **Do NOT** expand `Description()` to Bun marketing until parity.

### Definition of Done for a service

- [ ] All Bun leaf cmds in COVERAGE.md are `parity` **or** `deferred` with Pierre approval
- [ ] Lifecycle works (refresh+persist)
- [ ] No vault writes from `internal/services/<id>`
- [ ] `cd go && go test ./...` green
- [ ] Description() matches implemented surface only

---

## 6. Per-command Definition of Done (copy-paste)

Before marking a COVERAGE row `parity`, complete:

- [ ] Bun path, flags, args inventoried (link file:line in PR comment if non-obvious)
- [ ] Go cobra command registered under same path (or documented alias)
- [ ] Flag names match Bun (or alias + COVERAGE note)
- [ ] Uses `RequireProfile` / `ResolveProfile` — not ad-hoc profile picking
- [ ] Uses shared `getFreshCredentials` (Phase 1+) — not raw stored access token only
- [ ] Write cmds call `enforceWriteAccess` (or equivalent) when Bun does
- [ ] Client method covers Bun behavior (not a stub returning fake data)
- [ ] Unit test for client and/or command happy path where feasible
- [ ] `go test ./...` green
- [ ] COVERAGE.md row updated in **same PR**
- [ ] Description()/Short text does not advertise other missing cmds

---

## 7. Coverage tracking

Maintain **[COVERAGE.md](./COVERAGE.md)**.

- Tables for Gmail and Jira (and future services).
- Status: `missing` | `partial` | `parity` | `go-only` | `deferred`.
- **Update in the same PR as command ports.**

Current seed: Gmail 24 Bun leaf cmds / Go 4 partial+go-only; Jira 11 / Go 4; P0 lifecycle missing; Description overclaims.

---

## 8. Anti-patterns (reject in code review)

| Anti-pattern | Instead |
|--------------|---------|
| Feature port without matching Bun types/signatures | Map types in ARCHITECTURE / service package first |
| Profile CRUD inside `services/gmail` or `services/jira` | Call `profile.*` from CLI/host only |
| Hardcoded switch of services instead of Registry | `service.Default.Find` |
| `Description()` listing unimplemented cmds | Honest short description |
| Skipping token refresh persist | Persist in getFreshCredentials before API |
| Copying Bun directory layout literally under `src/` | `internal/services/<id>/` |
| Merging to main / adding WhatsApp / TS plugin loader | Non-goals |
| One mega-PR with lifecycle + all Gmail writes | One coherent slice per PR (§9) |

---

## 9. PR / branch rules for agents

- Branch from `go-port/skeleton` or `go-port/<slice>` (e.g. `go-port/lifecycle`, `go-port/jira-read`).
- **One coherent slice per PR:** lifecycle **OR** one service’s read cmds **OR** profile parity — not all three.
- PR comment: map Bun→Go for any new boundaries; link COVERAGE rows touched.
- **Never merge** unless Pierre says “merge”.
- Push to **`plosson/agentio`** only.
- Commit style: `feat(go): …` / `fix(go): …` / `docs(go): …`.
- After push: comment on the relevant PR (usually #86 until split) with file links.

---

## 10. Progress log

| When (Europe/Brussels) | Commit / tip | What | Next |
|------------------------|--------------|------|------|
| 2026-09-24 | `348da02` (+ this docs commit) | Phase 0 largely done: vault + daemon health + Bun-named profile APIs + ServicePlugin registry + Gmail/Jira smoke (`profile-info`/`labels list`, `myself`/`projects`). MIGRATION.md + COVERAGE.md added. P0 gap: no CredentialLifecycle; Description overclaims. | **Phase 1 — auth lifecycle** (shared getFreshCredentials + Google/Jira lifecycles + profile reauth). Then narrow Description(); then Phase 3 Jira remaining cmds. |

---

## Quick start for the next agent

```bash
cd go && go test ./...
# Read: ARCHITECTURE.md, MIGRATION.md §2–§6, COVERAGE.md
# Branch: git checkout -b go-port/lifecycle go-port/skeleton
# Implement Phase 1 only; update COVERAGE + §10; push; comment PR; DO NOT MERGE
```
