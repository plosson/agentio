# Architecture review — AgentIO Go skeleton (`go-port/skeleton`)

**Reviewer role:** expert software architect (Bun ground truth → Go fidelity)  
**Date:** 2026-09-24 (Europe/Brussels)  
**Scope:** `go/internal/**` vs Bun `src/**`  
**Constraint:** review + P0 structural rename only; do not merge.

---

## Executive summary

Pierre’s complaint is correct and earned a harsh grade on **package naming**. The skeleton invented a Go-only duality — `internal/service` (contract) beside `internal/services` (implementations) — that **does not exist in Bun**. Bun has one concept: **plugins**. Types and registry live *inside* `src/plugins/` (`types.ts`, `plugin-registry.ts`); each integration is `src/plugins/<name>/`. Calling the contract folder `service` and the implementations folder `services` is exactly the kind of “almost the same word, two folders” noise that makes a port feel alienated from the product.

Ownership boundaries (vault/profile host vs plugin Setup) were already directionally right. The registry + `AddProfileFromPlugin` path is good. What was wrong was the **vocabulary and folder taxonomy**, plus several P1 holes (no auth lifecycle, Google OAuth parked at top-level `internal/oauth`, CLI still owns command trees, Description strings copy Bun’s full surface while Go implements a handful of cmds).

**Verdict:** foundations usable; naming was a P0 product-smell. Fixed in this pass by aligning to Bun: `internal/plugin` + `internal/plugins/{gmail,jira}`. Remaining work is lifecycle, honest Descriptions, Google packaging, and command parity — not another layout invention.

---

## Bun layout vs Go layout (side-by-side)

### Bun ground truth (read first)

| Concern | Bun path | Notes |
|---|---|---|
| Plugin **types / contracts** | `src/plugins/types.ts` (+ `src/plugin-sdk/index.ts` for declarative) | `ServicePlugin`, `ProfilePlugin`, `CredentialLifecycle` — **named** Service* but **filed** under plugins |
| Thin client iface | `src/types/service.ts` | `ServiceClient` / `ValidationResult` only — not a parallel “services” tree |
| Plugin **implementations** | `src/plugins/<name>/` (gmail under `google/gmail/`) | **No** sibling `services/` plural next to a `service/` singular |
| Registry | `src/plugins/plugin-registry.ts`, `registry.ts` | Host catalog |
| Profile host | `src/plugins/profile-host.ts` | Persist is host-owned |
| Profile store | `src/config/profile-store.ts`, `config-manager.ts` | Core |
| Vault | `src/vault/*` | Core crypto + store |
| Daemon | `src/daemon/*` | Core |
| Top-level commands | `src/commands/*` | Core CLI |
| Auth refresh | `src/auth/refresh.ts` + per-plugin `lifecycle.ts` | Shared getFreshCredentials |
| Google shared OAuth | `src/plugins/google/oauth.ts`, `shared.ts`, `token-manager.ts` | **Under plugins/google**, not a top-level `oauth/` |

Bun naming summary: **plugins + shared config/vault**. Domain word *service* appears in type names (`ServicePlugin`) and vault keys — not as competing top-level folders.

### Go before this review (broken taxonomy)

```
go/internal/
  service/          # contract + registry   ← invented singular
  services/         # gmail, jira           ← invented plural sibling
  oauth/            # Google-specific helpers at core top-level
  profile/ vault/ daemon/ cli/
```

### Go after P0 rename (this pass)

```
go/internal/
  plugin/           # ServicePlugin + Registry  (Bun types + plugin-registry)
  plugins/
    gmail/          # Bun src/plugins/google/gmail (partial)
    jira/           # Bun src/plugins/jira
  oauth/            # still Google-skewed (P1 to relocate)
  profile/ vault/ daemon/ cli/
```

---

## Findings (ranked)

### P0 — Naming confusion: `service` vs `services`

- **Evidence:** `go/internal/service/*` + `go/internal/services/{gmail,jira}/*` (pre-rename); README/ARCHITECTURE documented both.
- **Why it hurts:** Bun contributors look for `plugins/`. Reviewers ask “wtf is service vs services?” (Pierre). Import paths teach the wrong mental model.
- **Fix (done):** Option A — `internal/plugin` (contract+registry) + `internal/plugins/{gmail,jira}`. Interface name `ServicePlugin` **kept** for Bun type fidelity; package path mirrors Bun folders.
- **Not renamed:** vault/profile parameter names `service` / `serviceName` — those are domain keys (`credentials[service][name]`), identical to Bun.

### P1 — Auth lifecycle missing (architectural hole)

- **Evidence:** `plugin.ServicePlugin` only exposes `Setup`; no `CredentialLifecycle` / refresh / reauthenticate. CLI Gmail/Jira API helpers load raw vault creds (`profile.GetCredentials`) with no Bun `getFreshCredentials` path. MIGRATION.md Phase 1 already flags this.
- **Bun:** `src/auth/refresh.ts` + plugin `credentialLifecycle` / `profile.refresh`.
- **Risk:** expired access tokens → flaky API; Atlassian refresh rotation unsafe without serialize+persist.

### P1 — `Description()` overclaims

- **Evidence:** `internal/plugins/gmail/setup.go` Description lists list/read/search/send/draft/… while CLI only wires `profile-info`, `labels list`, profile shims. Jira Description mentions search/comment/transition; Go has `myself`/`projects`.
- **Note:** Bun Gmail/Jira index.ts use the same long strings — correct for Bun, dishonest for a thin Go skeleton. MIGRATION invariant: narrow until parity.

### P1 — `internal/oauth` cohesion

- **Evidence:** `internal/oauth/google.go` is Gmail/Google OAuth + `TokenBundle`; `obscure.go` is shared reveal helper. Bun keeps Google OAuth under `src/plugins/google/`.
- **Recommendation:** move Google flow to `internal/plugins/google/` (or into `plugins/gmail` until a second Google surface lands); keep a tiny `internal/obscure` or `internal/cryptoobscure` if Reveal is shared. Top-level `oauth` as “core” overclaims generality (Jira OAuth already lives in `plugins/jira/oauth.go`).

### P1 — Boundary fidelity gaps on `ServicePlugin`

- **Present:** `ID`, `DisplayName`, `Description`, `Setup` ≈ Bun profile.setup.
- **Missing vs Bun:** `apiVersion` on instance (Go uses package const only — OK), `registerCommands` / declarative `commands`, `profile.createClient`, `credentialLifecycle`, `reauthenticate`, brand metadata.
- **Go-ism that is fine:** interface methods + `context.Context` on Setup; opaque `map[string]any` credentials until typed per plugin.
- **Go-ism to avoid:** inventing parallel nouns (`service`/`services`) — fixed.

### P2 — CLI monolith / package cohesion

- **Evidence:** `internal/cli` owns root, vault, daemon, profile, gmail, jira, register. Bun splits `src/commands/*` + per-plugin `commands.ts`. Acceptable for skeleton; later prefer plugin packages registering cobra cmds (or declarative DSL) so `cli` stays thin wiring.

### P2 — Import graph / knowledge boundaries

- **Good:** plugins do not import vault crypto; profile host persists. Jira OAuth stays in jira package.
- **Watch:** `cli` knows every plugin client constructor (`gmailAPIClient`, `jiraAPIClient`). Prefer plugin-owned “run with fresh creds” helpers once lifecycle exists.
- **No cycles found** in current tree after rename.

### P2 — Empty / thin stubs

- Daemon is health-only vs Bun routes-v1 — intentional skeleton, document honestly (README already does).
- No empty `internal/services` leftover after rename.

### P2 — stdlib `plugin` name collision risk

- Go stdlib has `plugin` (dynamic loading). Import path `…/internal/plugin` is fine; avoid bare import of both. Local variables must not be named `plugin` when the package is in scope (fixed in `cli/profile.go` / `AddProfileFromPlugin`).

---

## Recommended target layout (tree)

```
go/
  cmd/agentio/
  internal/
    vault/                     # core — AES-GCM/scrypt + Store
    profile/                   # core — SaveProfile, AddProfileFromPlugin, …
    daemon/                    # core — local HTTP
    plugin/                    # contract: ServicePlugin, Registry, Setup*
    plugins/
      gmail/                   # Setup + API client
      jira/                    # Setup + OAuth + API client
      google/                  # (P1) shared Google OAuth / snake lifecycle
    auth/                      # (P1) getFreshCredentials + lifecycle dispatch
    obscure/                   # (optional P1) Reveal helper if still shared
    cli/                       # thin cobra wiring + register.go
  ARCHITECTURE.md
  ARCHITECTURE_REVIEW.md       # this file
  MIGRATION.md
  COVERAGE.md
  README.md
```

**Rejected:** Option B packing contract `.go` files into `internal/plugins` parent package alongside subpackages — works in Go but makes `plugins.ServicePlugin` vs `plugins/gmail` easier to confuse for newcomers. Option A keeps contract singular and implementations plural, matching speech: “the plugin package” vs “the plugins”.

---

## Rename / move plan

| From | To | Status |
|---|---|---|
| `internal/service/*.go` | `internal/plugin/*.go` (`package plugin`) | **Done** |
| `internal/services/gmail` | `internal/plugins/gmail` | **Done** |
| `internal/services/jira` | `internal/plugins/jira` | **Done** |
| Imports `…/service`, `…/services/…` | `…/plugin`, `…/plugins/…` | **Done** |
| Docs ARCHITECTURE/README/MIGRATION | new paths + Package naming note | **Done** |
| `internal/oauth` Google bits | `internal/plugins/google` | Deferred P1 |
| Description strings | honest implemented surface | Deferred P1 |
| CredentialLifecycle | `internal/auth` + plugin hooks | Deferred P1 (MIGRATION Phase 1) |

---

## What to keep

- Vault wire format + `internal/vault` ownership.
- `internal/profile` as Bun profile-store + profile-host persist path.
- `ServicePlugin` **type name** (Bun) even though package is `plugin`.
- Registry registration in `cli/register.go` via `plugin.Default.MustRegister`.
- Per-plugin packages owning OAuth/API; never writing vault crypto.
- Strangler playbook in MIGRATION.md / COVERAGE.md (incorporate; don’t fork).
- Domain term *service* for vault keys and `profile add <service>` CLI.

---

## P0 implementation checklist (this PR slice)

- [x] Eliminate `internal/service` + `internal/services`
- [x] `go test ./...` green
- [x] Update ARCHITECTURE.md, README.md, MIGRATION.md Package naming
- [x] Record review in ARCHITECTURE_REVIEW.md
- [ ] PR #86 comment (after push)
- [ ] **Do not merge**
