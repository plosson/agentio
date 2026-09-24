# Go port coverage matrix

**Agents MUST update this file in the same PR as any command port.**
Status enum: `missing` | `partial` | `parity` | `go-only` | `deferred`

Playbook: [MIGRATION.md](./MIGRATION.md) · Boundaries: [ARCHITECTURE.md](./ARCHITECTURE.md)

Seeded from Bun `src/plugins/google/gmail/commands.ts` + `src/plugins/jira/commands.ts`
vs Go `internal/cli/{gmail,jira}.go` at tip of `go-port/skeleton` (`348da02` + docs).

---

## Summary (as of 2026-09-24)

| Service | Bun leaf cmds | Go parity | Go partial | Missing | Notes |
|---------|---------------|-----------|------------|---------|-------|
| Gmail   | 24            | 0         | 4          | 20      | Description() overclaims Bun surface |
| Jira    | 11            | 0         | 4          | 7       | Description() overclaims; `myself` is go-only smoke |
| Lifecycle | —           | —         | —          | **P0**  | No CredentialLifecycle / getFreshCredentials |

---

## Gmail (`service=gmail`)

Bun source: `src/plugins/google/gmail/commands.ts` + `createProfileCommands`.
Auth path: `getValidTokens` → `getFreshCredentials` + `googleSnakeCredentialLifecycle`.
Writes gated by `enforceWriteAccess('gmail', …)`.

| Bun cmd | Go cmd | status | notes |
|---------|--------|--------|-------|
| `gmail list` | — | missing | read; `--query`/`--limit`/`--profile` |
| `gmail get <id>` | — | missing | read |
| `gmail search <query>` | — | missing | read; Gmail query syntax |
| `gmail send` | — | missing | write-gated; compose flags `--to/--cc/--bcc/--subject/--subject-file/--body/--body-file/--spec/--html/--reply-to/--attachment/--inline` |
| `gmail draft [draft-id]` | — | missing | write-gated; same compose flags; create or update |
| `gmail draft delete <ids…>` | — | missing | write-gated |
| `gmail archive [ids…]` | — | missing | write-gated; `--chunk-size/--max-retries/--dry-run`; stdin IDs |
| `gmail mark <read\|unread> [ids…]` | — | missing | write-gated; bulk |
| `gmail labels list` | `gmail labels list` | partial | smoke only; no refresh lifecycle; flags TBD vs Bun |
| `gmail labels create <name>` | — | missing | write-gated |
| `gmail labels delete <id>` | — | missing | write-gated |
| `gmail labels rename <id> <name>` | — | missing | write-gated |
| `gmail filters list` | — | missing | read |
| `gmail filters get <id>` | — | missing | read |
| `gmail filters create` | — | missing | write-gated; criteria/action flags |
| `gmail filters delete <ids…>` | — | missing | write-gated |
| `gmail label` | — | missing | write-gated; add/remove labels on msgs/threads; bulk |
| `gmail attachment <msg-id>` | — | missing | read/download |
| `gmail export <msg-id>` | — | missing | PDF export |
| `gmail profile add` | `gmail profile add` | partial | shim → `profile add gmail`; missing `--read-only` on shim |
| `gmail profile list` | `gmail profile list` | partial | shim |
| `gmail profile update` | — | missing | `--read-only` / `--no-read-only` |
| `gmail profile rename` | — | missing | shim → `RenameProfile` |
| `gmail profile remove` | — | missing | shim → `DeleteProfile` |
| — | `gmail profile-info` | go-only | smoke (`users.getProfile`); keep or rename when Bun has equivalent doctor path |

**Honest Description() target (until parity):** do not list unimplemented cmds.
Current Go `Description()` overclaims (list/read/search/send/draft/…). Fix in Phase 1/3.

---

## Jira (`service=jira`)

Bun source: `src/plugins/jira/commands.ts` + `createProfileCommands`.
Auth path: `createClientGetter` → `getFreshCredentials` + `jiraCredentialLifecycle` (Atlassian refresh-token rotation).
Writes gated by `enforceWriteAccess('jira', …)`.

| Bun cmd | Go cmd | status | notes |
|---------|--------|--------|-------|
| `jira projects` | `jira projects` | partial | smoke; no `--limit`; no lifecycle refresh |
| `jira search` | — | missing | `--jql/--project/--status/--assignee/--limit` |
| `jira get <issue-key>` | — | missing | read |
| `jira comment <issue-key> [body]` | — | missing | write-gated; stdin body |
| `jira transitions <issue-key>` | — | missing | read |
| `jira transition <issue-key> <id>` | — | missing | write-gated |
| `jira profile add` | `jira profile add` | partial | shim; missing `--read-only` on shim; multi-site auto-picks first |
| `jira profile list` | `jira profile list` | partial | shim |
| `jira profile update` | — | missing | `--read-only` / `--no-read-only` |
| `jira profile rename` | — | missing | shim |
| `jira profile remove` | — | missing | shim |
| — | `jira myself` | go-only | smoke (`GET /myself`); acceptable until Bun parity docs say otherwise |

**Honest Description() target:** current Go text claims search/comment/transition — none ported. Narrow until parity.

---

## Shared / core (not per-service leaf cmds)

| Bun | Go | status | notes |
|-----|-----|--------|-------|
| vault AES-GCM/scrypt wire | `internal/vault` | partial | fixture decrypt exists; keep expanding golden vectors |
| `agentio profile add\|list\|remove\|rename` | same | partial | add/list/remove/rename present; `--read-only` on add OK |
| `agentio profile reauth` | — | missing | Phase 1 |
| `getFreshCredentials` + persist | — | **missing (P0)** | Phase 1 |
| `CredentialLifecycle` (Google snake + Jira) | — | **missing (P0)** | Phase 1 |
| `enforceWriteAccess` | — | missing | Phase 2/3 |
| daemon `/health` | yes | partial | full v1 API later (Phase 4) |
| WhatsApp | — | deferred | explicit non-goal |
| `AGENTIO_PLUGIN_PATHS` | — | deferred | explicit non-goal |

---

## How to update (agents)

1. Port a command → set its row to `partial` (wired) then `parity` when §6 DoD in MIGRATION.md is checked.
2. Never mark `parity` without shared lifecycle + write-gate (if Bun gates) + flag name match.
3. Add new rows when inventoring a new service; do not delete Bun rows — mark `deferred` with Pierre approval instead.
4. Same PR as the code change. Update Progress log in MIGRATION.md §10.
