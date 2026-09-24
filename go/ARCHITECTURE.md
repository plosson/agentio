> **Agents:** follow **[MIGRATION.md](./MIGRATION.md)** for phased port rules; track cmds in **[COVERAGE.md](./COVERAGE.md)**.

# Go skeleton architecture — Bun domain model → Go

This tree ports **boundaries and signatures**, not a thinner Go-only redesign.
Package layout follows Go idioms (`cmd/`, `internal/`); the *contracts* mirror Bun.

## Ownership (isolation)

| Concern | Bun | Go | Who owns it |
|---|---|---|---|
| Vault crypto (AES-GCM/scrypt) | `src/vault/crypto.ts` | `internal/vault` (`EncryptVault`/`DecryptVault`) | **core only** |
| Vault open/update/contents | `src/vault/vault.ts` | `internal/vault.Store` (`Open`, `Update`, `VaultContents`) | **core only** |
| Profile CRUD | `src/config/profile-store.ts` | `internal/profile` (`SaveProfile`, `DeleteProfile`, …) | **core only** |
| Profile resolve/list | `src/config/config-manager.ts` | `internal/profile` (`ResolveProfile`, `ListProfileRefs`, …) | **core only** |
| Host: setup → persist | `src/plugins/profile-host.ts` | `profile.AddProfileFromPlugin` / `PersistSetupResult` | **core only** |
| Plugin contract | `src/plugins/types.ts` + `src/plugin-sdk` | `internal/service.ServicePlugin` | **shared contract** |
| Plugin registry | `src/plugins/plugin-registry.ts` | `internal/service.Registry` | **core** |
| Gmail OAuth + API | `src/plugins/google/gmail/` | `internal/services/gmail` | **service** |
| Jira OAuth + API | `src/plugins/jira/` | `internal/services/jira` | **service** |
| Daemon | `src/commands/daemon.ts` + server | `internal/daemon` | **core** |
| CLI wiring | `src/commands/*`, `declarative.ts` | `internal/cli` | **core** (thin) |

**Rule:** a service’s `Setup` returns credentials; it never writes the vault.
`agentio profile add <service>` looks up the plugin in the registry and calls
`profile.AddProfileFromPlugin` — the same path for Gmail and Jira.

## Bun → Go boundary map

### Plugin / service contract

| Bun | Go |
|---|---|
| `ServicePlugin.id` | `ServicePlugin.ID()` |
| `ServicePlugin.displayName` | `ServicePlugin.DisplayName()` |
| `ServicePlugin.description` | `ServicePlugin.Description()` |
| `ServicePlugin.apiVersion` | `service.APIVersion` (=1) |
| `ProfilePlugin.setup` / `ProfileSpec.setup` | `ServicePlugin.Setup(ctx, SetupOptions)` |
| `SetupOptions` (`profile?`, `readOnly?`) | `service.SetupOptions` |
| `SetupResult<Credentials>` (`credentials`, `suggestedProfileName`, `info?`) | `service.SetupResult` |
| `PluginRegistry` / `SERVICE_PLUGINS` | `service.Registry` / `service.Default` |
| `addProfileFromPlugin(plugin, options)` | `profile.AddProfileFromPlugin(ctx, store, plugin, opts)` |
| `persistSetupResult` | `profile.PersistSetupResult` |

### Profile store / config-manager

| Bun | Go |
|---|---|
| `saveProfile(service, name, credentials, options)` | `profile.SaveProfile` |
| `deleteProfile(service, name)` | `profile.DeleteProfile` |
| `renameProfile(service, from, to)` | `profile.RenameProfile` → `WriteOutcome` |
| `chooseProfileName(service, {explicit, derived, readOnly})` | `profile.ChooseProfileName` + `ProfileNameChoice` |
| `listProfileRefs()` | `profile.ListProfileRefs` |
| `listProfiles(service?)` | `profile.ListProfiles` |
| `resolveProfile(service, name?)` | `profile.ResolveProfile` / `RequireProfile` |
| `getProfile` / `hasProfile` | `profile.GetProfile` / `HasProfile` |
| `getCredentials(service, profile)` | `profile.GetCredentials` |
| `ProfileRef` | `profile.ProfileRef` |
| `SetProfileOptions` | `profile.SetProfileOptions` |
| `WriteOutcome` (`ok`/`absent`/`taken`/`denied`) | `profile.WriteOutcome` |

### Vault domain model

| Bun | Go |
|---|---|
| `VaultContents { version, config, credentials }` | `vault.VaultContents` (= `Contents`) |
| `config.profiles[service][]` | `Contents.Config.Profiles` |
| `credentials[service][name]` | `Contents.Credentials` |
| `CURRENT_VAULT_VERSION` | `vault.CURRENT_VAULT_VERSION` |
| `encryptVault` / `decryptVault` | `EncryptVault` / `DecryptVault` (AES-256-GCM + scrypt N=16384,r=8,p=1) |
| `loadVault` / `updateVault` / `unlockVault` | `Store.Load` / `Store.Update` / `Open` |
| `readPointer` / `writePointer` | `ReadPointer` / `WritePointer` |

### Per-service credential shapes (vault wire)

| Service | Bun type | Go type / map keys |
|---|---|---|
| Gmail | Google snake OAuth tokens | `oauth.TokenBundle` → `access_token`, `refresh_token`, `expiry_date`, … |
| Jira | `JiraCredentials` camelCase | `jira.Credentials` → `accessToken`, `refreshToken`, `expiryDate`, `cloudId`, `siteUrl` |

## Adding a service (proven with Jira)

1. Implement `service.ServicePlugin` under `internal/services/<id>/` (`Setup` returns credentials only).
2. `service.Default.MustRegister(New())` in `internal/cli/register.go`.
3. Optional thin CLI under `internal/cli/<id>.go` for API commands; profile shims call `addProfileForService`.
4. **Do not** touch `internal/vault` or `internal/profile` CRUD.

Jira was added this way: no Gmail changes, no vault/profile duplication — only registry registration + new package + CLI API cmds (`myself`, `projects`).

## Intentional differences (skeleton)

- No declarative command DSL yet (Bun `CommandSpec`); API cmds are hand-wired cobra.
- No `CredentialLifecycle` / refresh / reauthenticate hooks yet (interface ready to grow).
- No remote hub / API-key profile paths (`saveProfileForKey`, …).
- Jira multi-site picker auto-selects the first site (logs alternatives); Bun prompts.
- No WhatsApp, no external TS plugins, no other full services beyond Gmail + Jira.
