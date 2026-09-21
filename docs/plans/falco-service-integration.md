# TRD: Falco as an agentio service plugin

Status: Draft — no code written.
Target: agentio **3.0.1** (`89142c3`). Authoritative contract: `docs/service-plugins.md`.
Source: **`/Users/plosson/devel/projects/personal/falcio`** — github.com/plosson/falcio at v0.2.0. Every `falcio/…` path below is relative to that folder.

---

## 1. Summary

Fold the standalone `falcio` CLI into agentio as the `falco` service plugin, then leave the falcio repo running in parallel until the port is proven. All of falcio moves, `sync` included.

falcio is a Bun CLI for Falco (Horus Software), a Belgian accounting product. It reads a company's Peppol inbox, downloads UBL invoices, renders them to PDF, lists outbound billing documents, and flips invoice payment status. 3,281 lines across 21 files; two runtime dependencies (`fast-xml-parser`, `pdf-lib`).

It reimplements infrastructure agentio already has — profiles, credential storage, token refresh, self-update, a release pipeline, an install site — and gets the weaker version of each. Most consequentially, falcio stores its refresh token in **plaintext** at `~/.config/falcio/accounts/*.json` (mode 0600). agentio would hold it in the AES-256-GCM vault, under API-key scopes and read-only enforcement.

Roughly 900 of falcio's lines are deleted rather than ported, because host infrastructure replaces them. Estimated **~4.5 days** across five stages.

## 2. Goals

1. Every falcio capability reachable as `agentio falco …`, with no loss of behaviour.
2. Falco credentials in the vault, covered by API keys, read-only profiles and remote mode like any other service.
3. falcio's auth, profile, prompt and update machinery deleted, not ported.
4. The plugin satisfies `docs/service-plugins.md`: one `ServicePlugin` export, one registry entry, one lifecycle entry.

### Non-goals

- Archiving or deprecating the falcio repo. Deliberately deferred; the two tools coexist.
- Any change to the plugin contract or the host. Falco fits both as written.
- The Falco Partner API. falcio targets the internal API the Electron desktop app uses (`falcio/src/lib/api.ts:1-2`); that does not change.
- Deriving `ServiceName` from the registry (see §11.4).

## 3. Why the fit is close

### 3.1 The same profile rule, written twice

`src/utils/client-factory.ts:12-13`:

> "Resolve which profile a command runs against. Explicit names must exist; one configured profile selects itself; several require `--profile`."

`falcio/src/lib/profile.ts:42-43` states the same rule in its own words. falcio arrived at agentio's design independently, so the profile work here is **deletion**, not reconciliation: `createClientGetter` replaces falcio's `ensureAccessToken()`, and `createProfileCommands` replaces its `profile list`.

### 3.2 The plugin contract asks for exactly what Falco has

`CredentialLifecycle` (`src/plugins/types.ts:16-25`) requires four things — `secretFields`, `applies`, `isStale`, `refresh` — and Falco supplies all four. The host keeps vault reads and writes, refresh serialization and CLI error mapping. `ProfilePlugin.reauthenticate` (`:13`) is documented as *"Return replacement credentials; the host remains responsible for persistence"*, which removes the persistence question entirely.

### 3.3 Nothing about the command shape is new

Three-level nesting is established: `agentio revolut counterparties list`, `revolut drafts list`, `revolut links list`. `agentio falco peppol list` needs no new mechanism.

Multi-file directory output is established too: `agentio revolut receipt --output <dir>` (`src/plugins/revolut/commands.ts:509`) and `agentio gmail attachment --output <dir>` (`src/plugins/google/gmail/commands.ts:989`) both write several files into a directory, the former with a `uniqueFilename(used, …)` collision helper (`src/plugins/revolut/commands.ts:254`) that closely resembles falcio's `uniqueBasename` (`falcio/src/lib/naming.ts:105`).

Nor is the dependency weight a concern: agentio ships 16 dependencies including nine `@googleapis/*` packages, `libsodium-wrappers` and `marked`.

### 3.4 The one thing agentio has never done

**No agentio command keeps a persisted manifest for incremental resume across runs.** Revolut's `used` set is per-invocation and in-memory. falcio's `.manifest.json` survives between runs and is what makes a second `sync` a no-op. This is one new idea, confined to one plugin folder. §7 specifies it.

## 4. Falco API surface

Three hosts, all reached over HTTPS with a bearer access token (`falcio/src/lib/api.ts:4-9`):

| Constant | Host | Role |
|---|---|---|
| `AUTH_URL` | `accounts.horus-software.be` | Login, refresh, revoke |
| `API_URL` | `api.my-falco.be` | Peppol, invoices, user |
| `BILLING_API_URL` | `horusapi-billing.azurewebsites.net` | Outbound billing documents |

### 4.1 Auth endpoints

| Endpoint | Method | Notes |
|---|---|---|
| `/login` | POST | JSON body: `userName`, `password`, `twoFaCode`, `brand: "falco"`, `impersonate: null`, `scopes` (`["myhorus","billing","falco","oclaf"]`). Answers `two_factor_required` as an error code, not a status. |
| `/oauth2/token` | POST | **`FormData`**, not JSON: `grant_type=refresh_token`, `scope` (`myhorus billing oclaf` — note: narrower than login), `refresh_token`. Returns a **rotated** `refresh_token`. |
| `/revoke-refresh-token` | POST | JSON `{ RefreshToken }`. Fire-and-forget; falcio swallows failures. |

### 4.2 Data endpoints

| Endpoint | Method | Used by |
|---|---|---|
| `/user/me` | GET | `profile add` — returns the organization list |
| `/peppol/documents/{orgId}?…` | GET | `peppol list`, `peppol sync`. Cursor pagination via `last=<uuid>` |
| `/peppol/document/{documentId}` | GET | `peppol get`, `peppol sync`. Serves **raw UBL XML**, not JSON |
| `/api.billing/billing-documents/period/{orgId}` | POST | `invoices sync` |
| `/api.billing/billing-documents/src/{docId}` | GET | `invoices sync` — PDF bytes |
| `/document/invoices?…` | GET | `peppol mark-paid` — locates the invoice |
| `/document/invoices/status` | PUT | `peppol mark-paid` — body `{ DocumentId, PaymentStatus }` |

Two pagination walkers wrap the list endpoints (`listAllPeppolDocuments`, `listAllInvoices`) and must be preserved; both take a progress callback that the sync commands use for per-page output.

## 5. Credential and profile model

### 5.1 The organization problem

agentio profiles are one per account. falcio profiles are one per **(account, organization)** pair, because a Falco login can hold several organizations and every data endpoint is scoped to one.

**Resolution: no host change.** The plugin owns its credential shape, so the organization becomes a credential field. A profile is then an (account, org) pair exactly as in falcio; the org is chosen once during `profile.add`. Two orgs on one login would mean two profiles, named after each org.

**Observed reality (2026-09-20).** The live falcio install holds two profiles — `default` (plosson@gmail.com → Losson & Associés) and `letschill` (pierre@letschill.be → LETSCHILL SRL). They are **two different accounts, each with exactly one organization**; `whoami` reports `Other orgs: 0` for both. So the multi-org-per-account branch has no instance in practice, and today's real usage is plain per-account profiles — agentio's native model.

Keep `organizationId` in the credentials regardless: every data endpoint in §4.2 is org-scoped, so the value must be stored whether or not an account ever holds a second org. But treat multi-org as a case the model *permits* rather than a constraint that drives the design, and do not spend Stage 1 building for it.

```ts
// src/plugins/falco/types.ts
export interface FalcoCredentials {
  /** Rotating; the only long-lived secret. */
  refreshToken: string;
  /** Unix ms — when refreshToken itself dies, not the access token. */
  refreshExpiryDate: number;
  accessToken?: string;
  /** Unix ms. */
  expiryDate?: number;
  organizationId: string;
  organizationName?: string;
  userId: string;
  userEmail: string;
}
```

### 5.2 Credential lifecycle

Falco rotates its refresh token on every exchange (`falcio/src/lib/api.ts:78-96`), so a dropped write is fatal rather than merely wasteful. The host already guards this: `getFreshCredentials` serialises per `service/profile` (`src/auth/refresh.ts:62`) for Atlassian's identical hazard. Falco inherits that protection by registering a lifecycle.

Model on `src/plugins/revolut/lifecycle.ts`:

```ts
// src/plugins/falco/lifecycle.ts
export const falcoCredentialLifecycle: CredentialLifecycle<FalcoCredentials> = {
  secretFields: ['refreshToken'],
  applies(credentials): credentials is FalcoCredentials {
    return typeof credentials === 'object' && credentials !== null
      && !!(credentials as Partial<FalcoCredentials>).refreshToken;
  },
  // Falco access tokens are short-lived; a missing expiry means "refresh now".
  isStale: (c, now, bufferMs) => c.expiryDate === undefined || now + bufferMs >= c.expiryDate,
  async refresh(c) {
    const r = await refreshFalcoToken(c.refreshToken);
    return {
      ...c,
      accessToken: r.accessToken,
      expiryDate: Date.now() + r.expiresIn * 1000,
      refreshToken: r.refreshToken,                        // rotated — must be kept
      refreshExpiryDate: Date.now() + r.refreshTokenExpiresIn * 1000,
    };
  },
};
```

`secretFields: ['refreshToken']` is what keeps a remote agent from refreshing on its own; the hub does it instead (`redactForRemote`, `src/auth/refresh.ts:45`).

### 5.3 Profile naming

`chooseProfileName('falco', { explicit, derived, readOnly })` (`src/config/profile-store.ts:34`), with `derived` = a slug of the organization name. falcio's `slugify` (`falcio/src/lib/profile.ts:18-30`) ports into `src/plugins/falco/`, not into a shared util — no other plugin derives a name this way.

### 5.4 Interactive login

The one genuinely new mechanism. Falco authenticates with **email + password + optional 2FA** (`falcio/src/lib/api.ts:24-71`); no agentio plugin does this today, and the flow is not OAuth, so none of `src/auth/oauth-server.ts` applies.

`profile.add(options: ProfileAddOptions)` (`src/plugins/types.ts:10`) must:

1. Prompt for email, then password without echo, then a 2FA code when `/login` answers `two_factor_required`.
2. `GET /user/me` for the organization list.
3. Prompt for the organization when there is more than one; auto-select when there is exactly one.
4. Prompt for the profile name, defaulting to the org slug; `options.profile` skips the prompt.
5. `saveProfile('falco', name, credentials, { readOnly: options.readOnly })`.

Follow `revolutProfileAdd` (`src/plugins/revolut/commands.ts:997`) for shape and console conventions. Use `@inquirer/prompts` (already a dependency) rather than porting `falcio/src/lib/prompt.ts` — that file's hand-rolled raw-mode password reader exists only because falcio has no prompt library.

`profile.reauthenticate` wraps the same flow but reuses the stored `organizationId`, so the user is not asked to pick an org again.

## 6. Command surface

| falcio | agentio | Options |
|---|---|---|
| `falcio login` | `agentio falco profile add` | `--profile`, `--read-only` |
| `falcio whoami` | `agentio falco profile list` / `agentio status` | absorbed |
| `falcio logout` | `agentio falco profile remove <name>` | shared implementation |
| `falcio profile list` | `agentio falco profile list` | `createProfileCommands` |
| `falcio peppol list` | `agentio falco peppol list` | `--profile`, `--since`, `--sender`, `--format` |
| `falcio peppol get <id>` | `agentio falco peppol get <id>` | `--profile`, `--output`, `--extract-pdf` |
| `falcio peppol sync` | `agentio falco peppol sync` | `--profile`, `--output <dir>`, `--since`, `--sender`, `--extract-pdf`, `--force` |
| `falcio peppol mark-paid <id>` | `agentio falco peppol mark-paid <id>` | `--profile`, `--status`, `--unpaid`, `--format` |
| `falcio invoices sync` | `agentio falco invoices sync` | `--profile`, `--output <dir>`, `--since`, `--customer`, `--include`, `--force` |
| `falcio update` | *dropped* | `agentio update` covers it |

Conventions to honour on the way in:

- **`--out` becomes `--output`** — 27 occurrences across `src/plugins/`, including `--output <dir>`.
- **`--json` becomes `--format <text|json>`**, per `src/plugins/revolut/commands.ts:803`.
- Every command carries `--profile <name>` with the standard description.
- `peppol mark-paid` calls `enforceWriteAccess('falco', profile, 'mark an invoice as paid')` (`src/utils/read-only.ts:10`) before writing. It is the only write command.
- Attach usage examples with `addExamples`; the generated skill reads them.

### 6.1 Error mapping

falcio returns discriminated results — `ApiResult<T>` and `BinaryResult` (`falcio/src/lib/api.ts:110-116`) — and prints errors at the command layer. agentio clients **throw `CliError`** and implement `ServiceClient.validate()` (`src/types/service.ts:14`). The client is therefore rewritten, not copied. Map with `httpStatusToErrorCode` (`src/utils/errors.ts`) plus these specifics:

| Condition | `CliError` code | Suggestion |
|---|---|---|
| `/login` invalid credentials | `AUTH_FAILED` | re-run `agentio falco profile add` |
| `/login` invalid 2FA code | `AUTH_FAILED` | re-enter the code |
| refresh exchange fails | `TOKEN_EXPIRED` | `agentio reauth` (it prompts for the invalid profiles) |
| document id not found | `NOT_FOUND` | `agentio falco peppol list` |
| read-only profile on `mark-paid` | `PERMISSION_DENIED` | host-supplied via `enforceWriteAccess` |
| network failure | `NETWORK_ERROR` | — |

## 7. The sync pattern

Both sync commands share one algorithm. Only the manifest is new to agentio (§3.4).

### 7.1 Why a manifest

`.manifest.json` in the target directory maps Falco document id → basename on disk (`falcio/src/lib/manifest.ts:4-9`). It is needed because the on-disk name is **derived and human-readable** — date, counterparty, document number (`falcio/src/lib/naming.ts:42`) — so the document id cannot be recovered from the filename. Without the manifest, a re-run without `--force` cannot tell what it already holds, and a document whose metadata changed would be downloaded twice under two names.

### 7.2 The algorithm

For each document, after client-side filtering:

1. **Look up** the basename in `manifest.entries[id]`.
2. **New document** → compute `buildBasename(doc)`, pass it through `uniqueBasename` against a `basenameToId` reverse index so two documents never collide, then record it.
3. **Known document** → recompute the target basename. If it differs from the stored one (the counterparty or date changed upstream), **rename the files on disk** and update the manifest. Counted separately as `renamed`.
4. **Skip** when the target file already exists and `--force` was not passed.
5. **Download**, write, count.
6. **Save the manifest** once at the end.

Report a tally: `wrote`, `skipped`, `renamed`, `failed`, and for `peppol sync` also `pdfsEmbedded` / `pdfsRendered`. Exit non-zero only when `failed > 0`.

### 7.3 PDF acquisition, in order

1. If the UBL carries an embedded PDF rendition, extract it verbatim — `extractEmbeddedPdf` (`falcio/src/lib/ubl.ts:25`).
2. Otherwise render one from the parsed UBL — `renderUblXmlToPdf` (`falcio/src/lib/ubl-render.ts:379`).

Step 2 is why `pdf-lib` is required: the embedded rendition is **optional** in Peppol BIS Billing 3.0 and many senders omit it.

### 7.4 What to drop

`peppol sync` carries a one-shot migration that renames a legacy `<uuid>.xml` file to the derived basename (`falcio/src/commands/peppol/sync.ts:190-194`). That is falcio-internal history. Do not port it; a first `agentio falco peppol sync` into a fresh directory has no legacy layout to repair. Note it in the changelog for anyone pointing the new command at an old falcio directory.

### 7.5 Where the helpers live

Keep manifest and naming inside `src/plugins/falco/`. The plugin layout exists so a service can hold its own helpers; generalise only if a second plugin ever needs them.

## 8. File plan

New — one self-contained folder, per `docs/service-plugins.md`:

| File | Source | Approx. |
|---|---|---|
| `src/plugins/falco/index.ts` | pattern from `revolut/index.ts` | ~20 |
| `src/plugins/falco/types.ts` | `falcio/src/lib/api.ts` types + §5.1 | ~150 |
| `src/plugins/falco/client.ts` | `falcio/src/lib/api.ts:133-549`, rewritten per §6.1 | ~400 |
| `src/plugins/falco/commands.ts` | falcio's five commands + `profile.add` | ~650 |
| `src/plugins/falco/output.ts` | falcio's inline table printing | ~120 |
| `src/plugins/falco/lifecycle.ts` | §5.2 + reauthentication | ~90 |
| `src/plugins/falco/auth.ts` | `falcio/src/lib/api.ts:24-107` | ~120 |
| `src/plugins/falco/ubl-parse.ts` | `falcio/src/lib/ubl-parse.ts` | 281, near-verbatim |
| `src/plugins/falco/ubl-render.ts` | `falcio/src/lib/ubl-render.ts` | 383, near-verbatim |
| `src/plugins/falco/ubl.ts` | `falcio/src/lib/ubl.ts` | 44, verbatim |
| `src/plugins/falco/naming.ts` | `falcio/src/lib/naming.ts` | 119, verbatim |
| `src/plugins/falco/manifest.ts` | `falcio/src/lib/manifest.ts` | 47, verbatim |

Modified — four edits, matching the four numbered steps in `docs/service-plugins.md`:

1. `src/plugins/registry.ts` — one import, one `SERVICE_PLUGINS` entry (alphabetical: after `dropbox`).
2. `src/plugins/credential-lifecycles.ts` — one entry.
3. `src/types/config.ts` — `ServiceName` (`:50`) and `Config.profiles` (`:26-46`), both still hand-maintained.
4. `package.json` — add `fast-xml-parser`, `pdf-lib`.

Generated: `claude/skills/agentio-falco/SKILL.md` via `agentio skill falco` (`src/commands/skill.ts:103`). It is auto-generated from command metadata — write good `addExamples` blocks and the skill follows.

**Deleted on the way in, not ported** — `falcio/src/lib/{store,profile,auth,prompt,version}.ts` and `falcio/src/commands/{update,login,logout,whoami,profile/list}.ts`, roughly 900 lines replaced by host infrastructure.

## 9. Testing

Tests live under `tests/`, mirroring `src/` (`AGENTS.md:73`) — **not** co-located, and **not** under `src/`. `tests/plugins/revolut/client.test.ts` is the model.

- `tests/plugins/falco/client.test.ts` — error mapping per §6.1, pagination walkers, the `ApiResult` → `CliError` translation.
- `tests/plugins/falco/ubl-parse.test.ts` — parse a fixture UBL invoice; assert parties, lines, totals, structured payment reference.
- `tests/plugins/falco/manifest.test.ts` — the §7.2 algorithm: new document, known document, upstream rename, collision between two documents, second run is a no-op.
- `tests/plugins/falco/naming.test.ts` — basename derivation and `uniqueBasename` collisions.
- `tests/plugins/registry.test.ts` — existing; will pick up `falco` automatically.

**Any test touching the vault must point `HOME` at a `mkdtemp` directory** (`AGENTS.md:74-77`). The suite refuses vault writes outside the OS temp directory, which is what stops a test run reaching a real vault.

Gate each stage on `bun run typecheck`, `bun test` and `bun run build` — the three commands `docs/service-plugins.md` step 6 names.

## 10. Staging

**Stage 1 — plugin skeleton.** `types.ts`, `auth.ts`, `lifecycle.ts`, client with `validate()`, `profile.add`, `index.ts`, both registry entries, `ServiceName`.
*Done when:* `agentio falco profile add` stores a real profile in the vault; `agentio falco profile list` shows it; `agentio status` validates it through `profile.createClient`; and a forced refresh rotates the token without losing it (falcio does this correctly today — both live profiles rotated and persisted cleanly, which is the behaviour to preserve).

**Stage 2 — read commands.** `peppol list`, `peppol get`, `output.ts`.
*Done when:* both run against a real Peppol inbox and `--extract-pdf` yields a valid PDF.

**Stage 3 — the write command.** `peppol mark-paid` with `enforceWriteAccess`.
*Done when:* the status flips against a real invoice, and a read-only profile is refused.

**Stage 4 — sync.** UBL modules, naming, manifest, `peppol sync`, `invoices sync`.
*Done when:* a sync into an empty directory matches what falcio v0.2.0 produces for the same inputs; a second run is a no-op; a renamed upstream document renames on disk exactly once.

**Stage 5 — the checklist.** `agentio skill falco`, docs, examples, remaining tests.

Stage 4 carries ~800 of the ported lines and all of the PDF rendering. Schedule it generously and verify `pdf-lib` under `--compile --bytecode` early in it, not at the end.

## 11. Risks

| Risk | Assessment |
|---|---|
| **Rotating refresh token lost to a concurrent refresh** | Handled by the host. `serialized()` (`src/auth/refresh.ts:62`) serialises per profile for Atlassian's identical hazard. Concurrent *CLI invocations* against one vault remain unsupported — unchanged (`docs/design/remote-vault.md`). |
| **Unverified: does a second Falco login invalidate the first refresh token?** | Downgraded. Only bites when one account holds two orgs, which no live profile does (§5.1). Cross-account independence *is* confirmed: both live profiles refreshed and rotated their tokens independently on 2026-09-20, each persisting a new token, with neither disturbing the other. Re-check only if an account ever gains a second org. |
| **`pdf-lib` under the native build** | Pure JS and working in falcio today, but agentio compiles with `--compile --minify --bytecode`. Verify early in Stage 4. |
| **Internal API with no contract** | `api.my-falco.be` is what the desktop app calls and can change without notice. Unchanged risk, newly inherited by agentio. The three-host split (§4) makes a partial outage plausible — fail per command, not globally. |
| **2FA blocks unattended `profile add`** | Acceptable: OAuth plugins also need a browser once. State it in the skill so an agent does not retry in a loop. |
| **Scope narrowing on refresh** | Login requests four scopes, refresh only three (`myhorus billing oclaf` — no `falco`). Reproduce exactly; do not "fix" it without evidence. |

## 12. Open questions

1. **Does a second Falco login invalidate the first refresh token?** Open but **not blocking and not currently testable** — it concerns two orgs on *one* account, and neither live account has a second organization (§5.1). Cross-account independence is already confirmed. Answer it if and when an account gains a second org; do not hold Stage 1 for it.
2. **Should `invoices` be a third-level group (`falco invoices sync`) or a flag on one sync command?** §6 assumes the former, matching falcio. Revisit if `invoices` never grows a second subcommand.
3. **Should the daemon schedule Peppol polls?** Not examined. Peppol inboxes are poll-shaped, so a scheduled `peppol sync` may fit naturally. Out of scope; worth its own note.
4. **`ServiceName` and `Config.profiles` remain hand-maintained.** `docs/service-plugins.md` step 5 calls them legacy, "until those legacy types are derived from the registry". Falco adds the twentieth hand-written entry. Not this port's job, but it is one more argument for doing it.
