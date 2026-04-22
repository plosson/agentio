# Vault Encryption Design

Replace agentio's plaintext `config.json` and machine-bound `tokens.enc` with a single passphrase-encrypted **vault** file. Add an `agentio setup` command as the sole entry point for vault lifecycle operations.

## Goals

- Store all agentio config and credentials in one encrypted file, protected by a user passphrase.
- Let users put the vault anywhere (default under `~/.config/agentio/`, but overridable — e.g., synced folder).
- Resolve the passphrase silently via OS keychain so normal commands stay non-interactive.
- Provide one clear migration path for existing installs.
- Keep runtime state (gateway DB, media, logs) machine-local, not in the vault.

## Non-goals

- No passphrase recovery mechanism. Lost passphrase = re-run `agentio setup --reset`.
- No TTL / auto-lock. OS keychain protection is sufficient.
- No changes to the existing `config export`/`config import` flow (CI/CD use case stays independent).
- No in-command interactive passphrase prompts. Only `agentio setup` prompts.

## Architecture

### New module: `src/vault/`

| File | Responsibility |
|------|----------------|
| `vault.ts` | Public API: `loadVault`, `saveVault`, `vaultExists`, `resetVault`. Single source of truth for the encrypted blob. In-memory cache for the process lifetime. |
| `crypto.ts` | scrypt + AES-256-GCM primitives. Extracted from `src/commands/config.ts` so vault and export/import share one implementation. |
| `passphrase.ts` | `getPassphrase`, `setPassphrase`, `clearPassphrase`. Resolution chain (env → cache → keychain). Wraps a `KeychainProvider` interface for test mocking. |
| `pointer.ts` | Manages `~/.config/agentio/vault.path` (a plaintext file holding the absolute path to the vault). |
| `migrate.ts` | One-shot migration from legacy `config.json` + `tokens.enc` into a vault. Called by `setup`. |

### Existing module changes

- **`src/config/config-manager.ts`** — `loadConfig` / `saveConfig` delegate to `loadVault` / `saveVault` (read/write the `config` field of the vault payload). All other exports unchanged. `CONFIG_DIR` export stays for runtime files.
- **`src/auth/token-store.ts`** — `loadCredentials` / `saveCredentials` delegate to the same vault module (read/write the `credentials` field). Machine-bound key derivation is removed.

### New commands

- **`src/commands/setup.ts`** — registers `agentio setup` and `agentio setup --reset`.

### New dependency

- **`keytar`** — OS keychain bindings (macOS Keychain, libsecret on Linux, Windows Credential Manager). Wrapped behind `KeychainProvider` for test isolation.

## Vault file format

On-disk:

```
base64( salt(32) || iv(16) || ciphertext || tag(16) )
```

- `salt` — random per vault, used to derive the AES key via scrypt.
- `iv` — AES-GCM nonce.
- `ciphertext` — AES-256-GCM-encrypted plaintext payload.
- `tag` — 16-byte GCM auth tag.

Plaintext payload (JSON):

```json
{
  "version": 1,
  "config": { /* current Config shape */ },
  "credentials": { /* current StoredCredentials shape */ }
}
```

Scrypt parameters are constants in `crypto.ts` (N=16384, r=8, p=1). A future parameter change is handled by bumping `version`.

Writes are atomic: write to `<vault>.tmp`, then `rename` over the target.

## Pointer file

`~/.config/agentio/vault.path` holds the absolute path to the vault. One line, plaintext, `0600`. Absent means "no vault configured".

## Passphrase resolution

`getPassphrase()` resolves in order:

1. `AGENTIO_PASSPHRASE` env var.
2. Process memory cache (set on first successful resolve in the process).
3. OS keychain entry (`service: agentio`, `account: vault`).
4. Fail with `VAULT_LOCKED`. No prompt.

Interactive passphrase prompts happen **only** in `agentio setup`.

### Stale keychain handling

If `getPassphrase` returns a value from the keychain and decryption subsequently fails, the keychain entry is deleted and `AUTH_FAILED` is thrown. The next invocation will report `VAULT_LOCKED`, directing the user to run `setup` again rather than repeatedly failing with wrong-password errors.

## `agentio setup` flow

Detects state on run and dispatches:

1. **No vault, no legacy files** → first-time setup.
2. **No vault, legacy `config.json` or `tokens.enc` present** → migration.
3. **Vault file exists at a user-specified path, no local pointer** → adopt existing vault (cross-machine scenario).
4. **Vault configured (pointer + file both present)** → existing-vault menu.

### First-time path

- Prompt: vault location (default `~/.config/agentio/vault.enc`).
- Prompt: passphrase (twice, masked, min 8 chars).
- Create empty vault payload, encrypt, write.
- Write pointer file. Write passphrase to keychain.

### Migration path

`migrate.ts` reads the legacy files directly via their own I/O (not through the now-refactored `loadConfig` / `loadCredentials`, which delegate to the vault). Writes go through the new vault API.

- Display: "Found legacy config at `<path>`. Import into new vault? [Y/n]".
- Prompt: vault location.
- Prompt: passphrase (twice).
- Read `config.json` directly. Decrypt `tokens.enc` directly using the legacy machine-bound key derivation (scrypt of `hostname-username-agentio-v1`).
- Combine into vault payload, encrypt via `saveVault`, write pointer, write keychain.
- Rename `config.json` → `config.json.bak`, `tokens.enc` → `tokens.enc.bak`. Do not delete.
- If legacy `tokens.enc` decryption fails (e.g., hostname changed since the install): abort the tokens portion, import only `config.json`, print a clear message that credentials couldn't be recovered and each service must be re-authenticated.

### Adopt-existing path

- User points at an existing vault file (e.g., copied from another machine via a synced folder).
- Prompt: passphrase.
- Verify by decrypting. If OK, write pointer and keychain.

### Existing-vault path (interactive menu)

- Change passphrase — prompt twice, re-encrypt vault, update keychain.
- Move vault file — prompt new absolute path. Copy vault to new location, verify by decrypting it at the new path, then update pointer, then delete old file. If the verify step fails, leave the original in place and surface the error — no data loss on partial failure.
- Cancel.

### `--reset`

- Confirm unless `--force`.
- Delete: vault file, pointer file, keychain entry, `.bak` legacy files.
- User re-runs `setup` to start fresh.

## Command gating

Registered as a Commander `preAction` hook on the root program. Runs before every subcommand.

Logic:

```
if command in bypass list → pass
if pointer file AND target vault file both exist → pass
otherwise → CliError(VAULT_NOT_CONFIGURED)
```

**Bypass list:** `setup`, `--help` / `-h` / no-command, `--version` / `-V`, `docs`, `update`.

Gating only verifies the vault exists. Decryption is lazy — happens on the first `loadConfig` or credential accessor call within the handler.

## Gateway daemon

Uses the same `getPassphrase()` chain. On desktop, keychain resolves silently. In Docker/headless, the operator launches the daemon with `AGENTIO_PASSPHRASE` set. If neither is available, the daemon fails fast with `VAULT_LOCKED`.

## Error handling

New `CliError` codes:

- `VAULT_NOT_CONFIGURED` — no pointer or no target vault file. → "Run: agentio setup".
- `VAULT_LOCKED` — passphrase unavailable. → "Run: agentio setup, or set AGENTIO_PASSPHRASE".
- `VAULT_CORRUPT` — malformed vault structure or post-decrypt JSON parse failure. → "Vault file may be damaged. Restore from backup or run: agentio setup --reset".

Reused codes:

- `AUTH_FAILED` — decryption fails on valid-looking input (wrong passphrase). → "Wrong passphrase. If changed elsewhere, run: agentio setup".
- `INVALID_PARAMS` — setup input validation (passphrase too short, non-absolute path).
- `CONFIG_ERROR` — pointer present but target vault missing. → "Vault file missing at <path>. Run: agentio setup".

### Atomic-write failure

`saveVault` cleans up `<vault>.tmp` in a `finally` block. The original vault is untouched because rename is atomic.

### Keychain-write failure during setup

Setup proceeds. A warning is printed: "Passphrase could not be stored in the OS keychain. Set `AGENTIO_PASSPHRASE` in your environment for future commands."

## Testing

All tests are automated. No manual verification checklist.

### Unit tests (`src/vault/*.test.ts`)

- **`crypto.test.ts`** — encrypt/decrypt round-trip; byte-layout assertion; GCM tag tamper rejection; wrong-passphrase rejection.
- **`vault.test.ts`** — `loadVault`/`saveVault` round-trip via temp dir; atomic-write failure leaves original intact and cleans up `.tmp`; `vaultExists` dangling-pointer case; version mismatch rejection.
- **`passphrase.test.ts`** — resolution chain order with fake `KeychainProvider`; env-var precedence over keychain; process-cache behavior; stale keychain entry cleared on decrypt failure; keychain-unavailable fallback.
- **`pointer.test.ts`** — create/read/delete; dangling-pointer distinct from missing-pointer.
- **`migrate.test.ts`** — legacy `config.json` + `tokens.enc` → vault round-trip; partial migration when `tokens.enc` is undecryptable; `.bak` renames (not deletions) confirmed.

### Integration tests (subprocess-driven, following existing patterns)

- **`commands/setup.test.ts`** — spawn the CLI against a temp `HOME`, script stdin for each path: first-time, migration, adopt-existing, existing-vault menu (change passphrase, move vault), `--reset`. Inject fake keychain via a test-only env var (e.g., `AGENTIO_KEYCHAIN=memory:/tmp/fake.json`).
- **`commands/gating.test.ts`** — fresh temp `HOME`, arbitrary service command → expect `VAULT_NOT_CONFIGURED`; run `setup`; same command now passes the gate; bypass list works without a vault.
- **Gateway daemon unlock** — spawn `agentio gateway start --foreground` with `AGENTIO_PASSPHRASE` set, assert startup; spawn without env and without keychain, assert `VAULT_LOCKED`.
- **Regression guard** — existing tests (`config-import.test.ts`, `server-tokens.test.ts`, etc.) keep passing after the facade refactor.

### Keychain abstraction for tests

`src/vault/passphrase.ts` defines a `KeychainProvider` interface (`get`, `set`, `delete`). Default implementation wraps `keytar`. Tests inject an in-memory fake. Platform-specific behavior (missing libsecret, keychain throws, stale entry) is exercised by making the fake throw as needed.

## Out of scope

- Passphrase recovery / escrow.
- Multiple vaults.
- Auto-lock / TTL.
- Replacing `config export`/`config import`; it keeps its independent random-key flow for CI/CD.
- Moving runtime files (`gateway.db`, `media/`, `gateway.log`) into the vault.
