# Vault Encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace agentio's plaintext `config.json` + machine-bound `tokens.enc` with a single passphrase-encrypted vault. Add `agentio setup` as the only entry point for vault lifecycle (first-time, migration, adopt-existing, passphrase change, move, reset). Every command gates on vault presence.

**Architecture:** New `src/vault/` module with five focused files (`crypto.ts`, `pointer.ts`, `passphrase.ts`, `vault.ts`, `migrate.ts`). Existing `src/config/config-manager.ts` and `src/auth/token-store.ts` become thin facades delegating to the vault. New `src/commands/setup.ts` handles all vault lifecycle. Commander `preAction` hook gates non-bypass commands.

**Tech Stack:** Bun runtime, TypeScript, Commander.js, `@inquirer/prompts`, Node's built-in `crypto` (scrypt + AES-256-GCM), new `keytar` dependency for OS keychain access.

**Design reference:** `docs/design/vault-encryption.md`

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `src/vault/crypto.ts` | Pure encrypt/decrypt primitives (scrypt + AES-256-GCM). Constants for KDF params. |
| `src/vault/pointer.ts` | Read/write/delete `~/.config/agentio/vault.path`. |
| `src/vault/passphrase.ts` | `KeychainProvider` interface, `keytar`-backed default, file-backed memory impl for tests, `getPassphrase`/`setPassphrase`/`clearPassphrase`, resolution chain. |
| `src/vault/vault.ts` | `loadVault`/`saveVault`/`vaultExists`/`resetVault`. Atomic writes. Process-level cache. |
| `src/vault/migrate.ts` | One-shot migration from legacy `config.json` + `tokens.enc` into a vault payload. |
| `src/commands/setup.ts` | `agentio setup` command, all paths. |
| `src/vault/crypto.test.ts` | Round-trip, tamper rejection, wrong-passphrase. |
| `src/vault/pointer.test.ts` | Create/read/delete, dangling detection. |
| `src/vault/passphrase.test.ts` | Resolution chain, stale entry, fake provider. |
| `src/vault/vault.test.ts` | Round-trip, atomic write, version mismatch. |
| `src/vault/migrate.test.ts` | Legacy → vault, partial migration, `.bak` renames. |
| `src/commands/setup.test.ts` | Subprocess-driven tests for each setup path. |
| `src/commands/gating.test.ts` | Gate behavior, bypass list. |

### Modified files

| File | Change |
|------|--------|
| `src/config/config-manager.ts` | `loadConfig`/`saveConfig` delegate to vault; env/profile helpers unchanged externally. |
| `src/auth/token-store.ts` | `loadCredentials`/`saveCredentials` delegate to vault; drop machine-bound key derivation. |
| `src/commands/config.ts` | Import encrypt/decrypt from `src/vault/crypto.ts` (remove duplicates). Keep export/import behavior identical. |
| `src/index.ts` | Register `setup` command. Add Commander `preAction` hook for gating. |
| `src/utils/errors.ts` | Add `VAULT_NOT_CONFIGURED`, `VAULT_LOCKED`, `VAULT_CORRUPT` codes. |
| `src/commands/config-import.test.ts` | Use new `seedVault` helper instead of writing `config.json` directly. |
| `package.json` | Add `keytar` dependency. |

---

## Task 1: Error codes for vault states

**Files:**
- Modify: `src/utils/errors.ts`

- [ ] **Step 1: Add vault error codes to the ErrorCode union**

Edit `src/utils/errors.ts`, add three codes to the union:

```typescript
export type ErrorCode =
  | 'AUTH_FAILED'
  | 'TOKEN_EXPIRED'
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFIG_ERROR'
  | 'VAULT_NOT_CONFIGURED'
  | 'VAULT_LOCKED'
  | 'VAULT_CORRUPT';
```

- [ ] **Step 2: Add exit codes for vault errors**

In the `exitCodeForError` switch, add:

```typescript
    case 'VAULT_NOT_CONFIGURED':
    case 'VAULT_LOCKED':
    case 'VAULT_CORRUPT':
      return 2;
```

Place these cases alongside the existing `AUTH_FAILED` case (same exit code).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/utils/errors.ts
git commit -m "feat(vault): add error codes for vault states"
```

---

## Task 2: Install keytar dependency

**Files:**
- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Install keytar**

Run: `bun add keytar`
Expected: `keytar` appears in `dependencies` in `package.json`.

- [ ] **Step 2: Verify keytar loads**

Run: `bun -e "import keytar from 'keytar'; console.log(typeof keytar.getPassword)"`
Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "feat(vault): add keytar dependency for OS keychain access"
```

---

## Task 3: crypto.ts — primitives (TDD)

**Files:**
- Create: `src/vault/crypto.ts`
- Test: `src/vault/crypto.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/crypto.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { encryptVault, decryptVault, CURRENT_VERSION } from './crypto';

describe('vault crypto', () => {
  test('encrypt/decrypt round-trip', () => {
    const plaintext = JSON.stringify({ version: CURRENT_VERSION, config: { profiles: {} }, credentials: {} });
    const passphrase = 'correct horse battery staple';
    const encrypted = encryptVault(plaintext, passphrase);
    const decrypted = decryptVault(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  test('encryption output is non-deterministic (random salt + iv)', () => {
    const plaintext = 'hello';
    const passphrase = 'pw';
    const a = encryptVault(plaintext, passphrase);
    const b = encryptVault(plaintext, passphrase);
    expect(a).not.toBe(b);
  });

  test('on-disk layout is base64(salt(32) || iv(16) || ciphertext || tag(16))', () => {
    const encrypted = encryptVault('x', 'pw');
    const buf = Buffer.from(encrypted, 'base64');
    // salt(32) + iv(16) + at least 1 byte ciphertext + tag(16) = min 65 bytes
    expect(buf.length).toBeGreaterThanOrEqual(65);
  });

  test('wrong passphrase throws', () => {
    const encrypted = encryptVault('secret', 'right');
    expect(() => decryptVault(encrypted, 'wrong')).toThrow();
  });

  test('tampered ciphertext throws (GCM auth tag)', () => {
    const encrypted = encryptVault('secret', 'pw');
    const buf = Buffer.from(encrypted, 'base64');
    // Flip a byte in the ciphertext region (after salt(32)+iv(16), before tag(16))
    buf[50] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decryptVault(tampered, 'pw')).toThrow();
  });

  test('malformed input throws', () => {
    expect(() => decryptVault('not-valid-base64-!!!', 'pw')).toThrow();
    expect(() => decryptVault('YWJj', 'pw')).toThrow(); // too short
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/vault/crypto.test.ts`
Expected: all tests fail with "Cannot find module './crypto'".

- [ ] **Step 3: Implement `crypto.ts`**

Create `src/vault/crypto.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT_LEN = 32;
const IV_LEN = 16;
const TAG_LEN = 16;
const KEY_LEN = 32;

// scrypt parameters. Bump CURRENT_VERSION if these change.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export const CURRENT_VERSION = 1;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
}

export function encryptVault(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, ciphertext, tag]).toString('base64');
}

export function decryptVault(encoded: string, passphrase: string): string {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('vault: encoded payload too short');
  }

  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN, buf.length - TAG_LEN);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf-8');
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/vault/crypto.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/vault/crypto.ts src/vault/crypto.test.ts
git commit -m "feat(vault): add crypto primitives (scrypt + AES-256-GCM)"
```

---

## Task 4: pointer.ts — vault path pointer (TDD)

**Files:**
- Create: `src/vault/pointer.ts`
- Test: `src/vault/pointer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/pointer.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  readPointer,
  writePointer,
  deletePointer,
  pointerPath,
  pointerExists,
} from './pointer';

let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-pointer-test-'));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('vault pointer', () => {
  test('pointerPath returns ~/.config/agentio/vault.path', () => {
    expect(pointerPath()).toBe(join(tempHome, '.config', 'agentio', 'vault.path'));
  });

  test('pointerExists false when absent', async () => {
    expect(await pointerExists()).toBe(false);
  });

  test('write then read returns the path', async () => {
    await writePointer('/some/vault.enc');
    expect(await readPointer()).toBe('/some/vault.enc');
  });

  test('pointerExists true after write', async () => {
    await writePointer('/some/vault.enc');
    expect(await pointerExists()).toBe(true);
  });

  test('readPointer returns null when absent', async () => {
    expect(await readPointer()).toBeNull();
  });

  test('deletePointer removes the file', async () => {
    await writePointer('/some/vault.enc');
    await deletePointer();
    expect(await pointerExists()).toBe(false);
    expect(existsSync(pointerPath())).toBe(false);
  });

  test('deletePointer is idempotent when absent', async () => {
    await deletePointer();
    await deletePointer();
  });

  test('writePointer trims trailing newlines on readback', async () => {
    await writePointer('/some/vault.enc');
    const raw = await Bun.file(pointerPath()).text();
    // File content can have a trailing newline, readPointer normalizes it
    expect(raw.trim()).toBe('/some/vault.enc');
    expect(await readPointer()).toBe('/some/vault.enc');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/vault/pointer.test.ts`
Expected: fail with "Cannot find module './pointer'".

- [ ] **Step 3: Implement `pointer.ts`**

Create `src/vault/pointer.ts`:

```typescript
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

function configDir(): string {
  return join(homedir(), '.config', 'agentio');
}

export function pointerPath(): string {
  return join(configDir(), 'vault.path');
}

export async function pointerExists(): Promise<boolean> {
  return existsSync(pointerPath());
}

export async function readPointer(): Promise<string | null> {
  const path = pointerPath();
  if (!existsSync(path)) return null;
  const content = await readFile(path, 'utf-8');
  return content.trim();
}

export async function writePointer(vaultPath: string): Promise<void> {
  const dir = dirname(pointerPath());
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(pointerPath(), vaultPath + '\n', { mode: 0o600 });
}

export async function deletePointer(): Promise<void> {
  const path = pointerPath();
  if (existsSync(path)) {
    await unlink(path);
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/vault/pointer.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/pointer.ts src/vault/pointer.test.ts
git commit -m "feat(vault): add pointer file helper"
```

---

## Task 5: passphrase.ts — keychain provider and resolution chain (TDD)

**Files:**
- Create: `src/vault/passphrase.ts`
- Test: `src/vault/passphrase.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/passphrase.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getPassphrase,
  setPassphrase,
  clearPassphrase,
  clearPassphraseCache,
  setKeychainProvider,
  resetKeychainProvider,
  type KeychainProvider,
} from './passphrase';

class MemoryKeychain implements KeychainProvider {
  store = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.store.get(account) ?? null;
  }
  async set(account: string, value: string): Promise<void> {
    this.store.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.store.delete(account);
  }
}

let mem: MemoryKeychain;

beforeEach(() => {
  mem = new MemoryKeychain();
  setKeychainProvider(mem);
  clearPassphraseCache();
  delete process.env.AGENTIO_PASSPHRASE;
});

afterEach(() => {
  resetKeychainProvider();
  clearPassphraseCache();
  delete process.env.AGENTIO_PASSPHRASE;
});

describe('passphrase resolution', () => {
  test('env var takes precedence', async () => {
    process.env.AGENTIO_PASSPHRASE = 'from-env';
    await mem.set('vault', 'from-keychain');
    expect(await getPassphrase()).toBe('from-env');
  });

  test('keychain used when env not set', async () => {
    await mem.set('vault', 'from-keychain');
    expect(await getPassphrase()).toBe('from-keychain');
  });

  test('process cache returns same value on second call', async () => {
    await mem.set('vault', 'from-keychain');
    expect(await getPassphrase()).toBe('from-keychain');
    // Delete from keychain — cache should still serve
    await mem.delete('vault');
    expect(await getPassphrase()).toBe('from-keychain');
  });

  test('clearPassphraseCache bypasses cache', async () => {
    await mem.set('vault', 'v1');
    expect(await getPassphrase()).toBe('v1');
    await mem.set('vault', 'v2');
    clearPassphraseCache();
    expect(await getPassphrase()).toBe('v2');
  });

  test('returns null when no source available', async () => {
    expect(await getPassphrase()).toBeNull();
  });

  test('setPassphrase writes to keychain and populates cache', async () => {
    await setPassphrase('new-pw');
    expect(await mem.get('vault')).toBe('new-pw');
    expect(await getPassphrase()).toBe('new-pw');
  });

  test('clearPassphrase wipes keychain and cache', async () => {
    await setPassphrase('pw');
    await clearPassphrase();
    expect(await mem.get('vault')).toBeNull();
    expect(await getPassphrase()).toBeNull();
  });

  test('keychain read error falls through gracefully', async () => {
    setKeychainProvider({
      async get() { throw new Error('no libsecret'); },
      async set() { throw new Error('no libsecret'); },
      async delete() { throw new Error('no libsecret'); },
    });
    expect(await getPassphrase()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/vault/passphrase.test.ts`
Expected: fail with "Cannot find module './passphrase'".

- [ ] **Step 3: Implement `passphrase.ts`**

Create `src/vault/passphrase.ts`:

```typescript
export interface KeychainProvider {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = 'agentio';
const ACCOUNT = 'vault';

let provider: KeychainProvider | null = null;
let cached: string | null = null;

function keytarProvider(): KeychainProvider {
  // Lazy require so tests using an injected provider don't need keytar loadable.
  const keytar = require('keytar');
  return {
    async get(account: string) {
      const v = await keytar.getPassword(SERVICE, account);
      return v ?? null;
    },
    async set(account: string, value: string) {
      await keytar.setPassword(SERVICE, account, value);
    },
    async delete(account: string) {
      await keytar.deletePassword(SERVICE, account);
    },
  };
}

function getProvider(): KeychainProvider {
  if (provider) return provider;
  provider = keytarProvider();
  return provider;
}

export function setKeychainProvider(p: KeychainProvider): void {
  provider = p;
}

export function resetKeychainProvider(): void {
  provider = null;
}

export function clearPassphraseCache(): void {
  cached = null;
}

export async function getPassphrase(): Promise<string | null> {
  if (process.env.AGENTIO_PASSPHRASE) {
    return process.env.AGENTIO_PASSPHRASE;
  }
  if (cached !== null) {
    return cached;
  }
  try {
    const v = await getProvider().get(ACCOUNT);
    if (v) {
      cached = v;
      return v;
    }
  } catch {
    // Keychain unavailable — fall through to null.
  }
  return null;
}

export async function setPassphrase(passphrase: string): Promise<void> {
  try {
    await getProvider().set(ACCOUNT, passphrase);
  } catch (err) {
    // Caller (setup) decides how to surface this; we still cache in-process
    // so the same process can keep working.
    cached = passphrase;
    throw err;
  }
  cached = passphrase;
}

export async function clearPassphrase(): Promise<void> {
  cached = null;
  try {
    await getProvider().delete(ACCOUNT);
  } catch {
    // Ignore — nothing we can do.
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/vault/passphrase.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/passphrase.ts src/vault/passphrase.test.ts
git commit -m "feat(vault): add passphrase resolution chain with pluggable keychain"
```

---

## Task 6: vault.ts — load/save/exists/reset (TDD)

**Files:**
- Create: `src/vault/vault.ts`
- Test: `src/vault/vault.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/vault.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  loadVault,
  saveVault,
  vaultExists,
  resetVault,
  clearVaultCache,
  CURRENT_VAULT_VERSION,
} from './vault';
import {
  clearPassphraseCache,
  resetKeychainProvider,
  setKeychainProvider,
  type KeychainProvider,
} from './passphrase';
import { writePointer, deletePointer } from './pointer';
import { encryptVault } from './crypto';

let tempHome = '';
let savedHome = '';
let vaultFile = '';

class MemoryKeychain implements KeychainProvider {
  store = new Map<string, string>();
  async get(a: string) { return this.store.get(a) ?? null; }
  async set(a: string, v: string) { this.store.set(a, v); }
  async delete(a: string) { this.store.delete(a); }
}

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-vault-test-'));
  process.env.HOME = tempHome;
  vaultFile = join(tempHome, 'vault.enc');
  const mem = new MemoryKeychain();
  setKeychainProvider(mem);
  clearPassphraseCache();
  clearVaultCache();
  delete process.env.AGENTIO_PASSPHRASE;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  resetKeychainProvider();
  clearPassphraseCache();
  clearVaultCache();
  delete process.env.AGENTIO_PASSPHRASE;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('vault', () => {
  test('vaultExists false when neither pointer nor file present', async () => {
    expect(await vaultExists()).toBe(false);
  });

  test('vaultExists false when pointer dangles (file missing)', async () => {
    await writePointer('/nonexistent/vault.enc');
    expect(await vaultExists()).toBe(false);
  });

  test('saveVault then loadVault round-trip', async () => {
    process.env.AGENTIO_PASSPHRASE = 'test-pw';
    await writePointer(vaultFile);
    const payload = {
      version: CURRENT_VAULT_VERSION,
      config: { profiles: { gmail: [{ name: 'work' }] } },
      credentials: { gmail: { work: { token: 'abc' } } },
    };
    await saveVault(payload);
    clearVaultCache();
    const loaded = await loadVault();
    expect(loaded).toEqual(payload);
  });

  test('saveVault writes atomically (no .tmp remains)', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    await saveVault({ version: 1, config: { profiles: {} }, credentials: {} });
    expect(existsSync(vaultFile + '.tmp')).toBe(false);
  });

  test('loadVault throws VAULT_NOT_CONFIGURED when no pointer', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
  });

  test('loadVault throws CONFIG_ERROR when pointer dangles', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer('/does/not/exist.enc');
    await expect(loadVault()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });

  test('loadVault throws VAULT_LOCKED when no passphrase', async () => {
    await writePointer(vaultFile);
    const encoded = encryptVault(
      JSON.stringify({ version: 1, config: { profiles: {} }, credentials: {} }),
      'pw'
    );
    await writeFile(vaultFile, encoded);
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('loadVault throws AUTH_FAILED on wrong passphrase and wipes stale keychain entry', async () => {
    const mem = new MemoryKeychain();
    setKeychainProvider(mem);
    await mem.set('vault', 'wrong-pw');

    await writePointer(vaultFile);
    const encoded = encryptVault(
      JSON.stringify({ version: 1, config: { profiles: {} }, credentials: {} }),
      'right-pw'
    );
    await writeFile(vaultFile, encoded);

    await expect(loadVault()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    // Stale entry should have been cleared
    expect(await mem.get('vault')).toBeNull();
  });

  test('loadVault throws VAULT_CORRUPT on malformed file', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    await writeFile(vaultFile, 'not-a-valid-vault');
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_CORRUPT' });
  });

  test('loadVault throws VAULT_CORRUPT on version mismatch', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    const encoded = encryptVault(
      JSON.stringify({ version: 999, config: { profiles: {} }, credentials: {} }),
      'pw'
    );
    await writeFile(vaultFile, encoded);
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_CORRUPT' });
  });

  test('resetVault deletes pointer, vault file, and keychain entry', async () => {
    const mem = new MemoryKeychain();
    setKeychainProvider(mem);
    await mem.set('vault', 'pw');
    await writePointer(vaultFile);
    await writeFile(vaultFile, 'anything');

    await resetVault();

    expect(existsSync(vaultFile)).toBe(false);
    expect(await mem.get('vault')).toBeNull();
  });

  test('loadVault caches across calls (second call does not re-decrypt)', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    const payload = { version: 1, config: { profiles: {} }, credentials: {} };
    await saveVault(payload);
    const a = await loadVault();
    // Corrupt the file on disk; cached value should still work
    await writeFile(vaultFile, 'corrupted');
    const b = await loadVault();
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/vault/vault.test.ts`
Expected: fail with "Cannot find module './vault'".

- [ ] **Step 3: Implement `vault.ts`**

Create `src/vault/vault.ts`:

```typescript
import { readFile, writeFile, unlink, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { CliError } from '../utils/errors';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';
import { encryptVault, decryptVault } from './crypto';
import {
  readPointer,
  pointerExists,
  deletePointer,
} from './pointer';
import {
  getPassphrase,
  clearPassphrase,
  clearPassphraseCache,
} from './passphrase';

export const CURRENT_VAULT_VERSION = 1;

export interface VaultContents {
  version: number;
  config: Config;
  credentials: StoredCredentials;
}

let cache: VaultContents | null = null;

export function clearVaultCache(): void {
  cache = null;
}

export async function vaultExists(): Promise<boolean> {
  if (!(await pointerExists())) return false;
  const path = await readPointer();
  if (!path) return false;
  return existsSync(path);
}

async function resolvePassphraseOrThrow(): Promise<string> {
  const pw = await getPassphrase();
  if (!pw) {
    throw new CliError(
      'VAULT_LOCKED',
      'Vault is locked',
      'Run: agentio setup, or set AGENTIO_PASSPHRASE'
    );
  }
  return pw;
}

export async function loadVault(): Promise<VaultContents> {
  if (cache) return cache;

  if (!(await pointerExists())) {
    throw new CliError(
      'VAULT_NOT_CONFIGURED',
      'No vault configured',
      'Run: agentio setup'
    );
  }
  const path = (await readPointer())!;
  if (!existsSync(path)) {
    throw new CliError(
      'CONFIG_ERROR',
      `Vault file missing at ${path}`,
      'Run: agentio setup'
    );
  }

  const pw = await resolvePassphraseOrThrow();
  const passphraseFromEnv = !!process.env.AGENTIO_PASSPHRASE;
  const encoded = await readFile(path, 'utf-8');

  let plaintext: string;
  try {
    plaintext = decryptVault(encoded.trim(), pw);
  } catch {
    // Wrong passphrase or corrupt file. Distinguish by trying to parse the
    // on-disk structure: if base64-decode works and sizes look plausible,
    // treat as auth failure (wrong passphrase). Otherwise treat as corrupt.
    const looksStructurallyValid = (() => {
      try {
        const buf = Buffer.from(encoded.trim(), 'base64');
        return buf.length >= 65; // salt + iv + >=1 + tag
      } catch {
        return false;
      }
    })();

    if (looksStructurallyValid) {
      // Wipe stale keychain entry if the passphrase came from there.
      if (!passphraseFromEnv) {
        await clearPassphrase();
      }
      throw new CliError(
        'AUTH_FAILED',
        'Wrong passphrase for vault',
        'If you changed the passphrase elsewhere, run: agentio setup'
      );
    }
    throw new CliError(
      'VAULT_CORRUPT',
      'Vault file is malformed',
      'Restore from backup or run: agentio setup --reset'
    );
  }

  let payload: VaultContents;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new CliError(
      'VAULT_CORRUPT',
      'Vault contents are not valid JSON',
      'Restore from backup or run: agentio setup --reset'
    );
  }

  if (payload.version !== CURRENT_VAULT_VERSION) {
    throw new CliError(
      'VAULT_CORRUPT',
      `Unsupported vault version: ${payload.version}`,
      'Upgrade agentio, or restore from backup'
    );
  }

  cache = payload;
  return payload;
}

export async function saveVault(contents: VaultContents): Promise<void> {
  if (!(await pointerExists())) {
    throw new CliError(
      'VAULT_NOT_CONFIGURED',
      'No vault configured',
      'Run: agentio setup'
    );
  }
  const path = (await readPointer())!;
  const pw = await resolvePassphraseOrThrow();

  const tmp = path + '.tmp';
  const encoded = encryptVault(JSON.stringify(contents), pw);

  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  try {
    await writeFile(tmp, encoded, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) {
      await unlink(tmp).catch(() => {});
    }
    throw err;
  }

  cache = contents;
}

export async function resetVault(): Promise<void> {
  if (await pointerExists()) {
    const path = await readPointer();
    if (path && existsSync(path)) {
      await unlink(path).catch(() => {});
    }
  }
  await deletePointer();
  await clearPassphrase();
  clearVaultCache();
  clearPassphraseCache();
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/vault/vault.test.ts`
Expected: all 11 tests pass.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. Note: `StoredCredentials` type is imported from `src/types/tokens`; if that file doesn't define it as expected, adjust import.

- [ ] **Step 6: Commit**

```bash
git add src/vault/vault.ts src/vault/vault.test.ts
git commit -m "feat(vault): add vault load/save with atomic writes and error taxonomy"
```

---

## Task 7: migrate.ts — legacy config + tokens → vault (TDD)

**Files:**
- Create: `src/vault/migrate.ts`
- Test: `src/vault/migrate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/vault/migrate.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir, hostname, userInfo } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import {
  detectLegacy,
  migrateLegacy,
  legacyPaths,
} from './migrate';

let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-migrate-test-'));
  process.env.HOME = tempHome;
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

function writeLegacyTokensEncWithKey(path: string, data: object, key: Buffer): void {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  Bun.write(
    path,
    JSON.stringify({
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: enc.toString('hex'),
    })
  );
}

function legacyMachineKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-agentio-v1`;
  return scryptSync(machineId, 'agentio-salt', 32);
}

describe('migrate', () => {
  test('detectLegacy returns false when nothing is present', async () => {
    const { hasConfig, hasTokens } = await detectLegacy();
    expect(hasConfig).toBe(false);
    expect(hasTokens).toBe(false);
  });

  test('detectLegacy finds config.json and tokens.enc', async () => {
    const { configPath, tokensPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    await writeFile(tokensPath, 'anything', { mode: 0o600 });
    const { hasConfig, hasTokens } = await detectLegacy();
    expect(hasConfig).toBe(true);
    expect(hasTokens).toBe(true);
  });

  test('migrateLegacy reads config and decrypts tokens with the machine key', async () => {
    const { configPath, tokensPath } = legacyPaths();
    const config = { profiles: { gmail: [{ name: 'work' }] }, env: { FOO: 'bar' } };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    writeLegacyTokensEncWithKey(
      tokensPath,
      { gmail: { work: { token: 'xyz' } } },
      legacyMachineKey()
    );

    const result = await migrateLegacy();
    expect(result.config).toEqual(config);
    expect(result.credentials).toEqual({ gmail: { work: { token: 'xyz' } } });
    expect(result.tokensRecovered).toBe(true);
  });

  test('migrateLegacy renames legacy files to .bak after success', async () => {
    const { configPath, tokensPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    writeLegacyTokensEncWithKey(tokensPath, {}, legacyMachineKey());

    await migrateLegacy();

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(tokensPath)).toBe(false);
    expect(existsSync(configPath + '.bak')).toBe(true);
    expect(existsSync(tokensPath + '.bak')).toBe(true);
  });

  test('migrateLegacy returns tokensRecovered:false when tokens.enc is undecryptable', async () => {
    const { configPath, tokensPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    // Write a tokens.enc encrypted with a WRONG key (simulates hostname change)
    writeLegacyTokensEncWithKey(tokensPath, { gmail: { work: { token: 'x' } } }, randomBytes(32));

    const result = await migrateLegacy();
    expect(result.tokensRecovered).toBe(false);
    expect(result.credentials).toEqual({});
  });

  test('migrateLegacy returns tokensRecovered:false when tokens.enc missing', async () => {
    const { configPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    const result = await migrateLegacy();
    expect(result.tokensRecovered).toBe(false);
    expect(result.credentials).toEqual({});
  });

  test('migrateLegacy throws when no config.json exists', async () => {
    await expect(migrateLegacy()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/vault/migrate.test.ts`
Expected: fail with "Cannot find module './migrate'".

- [ ] **Step 3: Implement `migrate.ts`**

Create `src/vault/migrate.ts`:

```typescript
import { readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';
import { createDecipheriv, scryptSync } from 'crypto';
import { CliError } from '../utils/errors';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

export function legacyPaths(): { configPath: string; tokensPath: string } {
  const dir = join(homedir(), '.config', 'agentio');
  return {
    configPath: join(dir, 'config.json'),
    tokensPath: join(dir, 'tokens.enc'),
  };
}

export async function detectLegacy(): Promise<{ hasConfig: boolean; hasTokens: boolean }> {
  const { configPath, tokensPath } = legacyPaths();
  return {
    hasConfig: existsSync(configPath),
    hasTokens: existsSync(tokensPath),
  };
}

function legacyMachineKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-agentio-v1`;
  return scryptSync(machineId, 'agentio-salt', 32);
}

function tryDecryptLegacyTokens(raw: string): StoredCredentials | null {
  try {
    const { iv, tag, data } = JSON.parse(raw);
    const key = legacyMachineKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(data, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf-8'));
  } catch {
    return null;
  }
}

export interface MigrateResult {
  config: Config;
  credentials: StoredCredentials;
  tokensRecovered: boolean;
}

export async function migrateLegacy(): Promise<MigrateResult> {
  const { configPath, tokensPath } = legacyPaths();

  if (!existsSync(configPath)) {
    throw new CliError(
      'NOT_FOUND',
      'No legacy config.json to migrate',
      'Run: agentio setup for a fresh install'
    );
  }

  let config: Config;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw) as Config;
  } catch (err) {
    throw new CliError(
      'CONFIG_ERROR',
      `Failed to read legacy config.json: ${(err as Error).message}`,
      'Fix or remove the file, then run setup again'
    );
  }

  let credentials: StoredCredentials = {};
  let tokensRecovered = false;
  if (existsSync(tokensPath)) {
    const raw = await readFile(tokensPath, 'utf-8');
    const recovered = tryDecryptLegacyTokens(raw);
    if (recovered) {
      credentials = recovered;
      tokensRecovered = true;
    }
  }

  // Rename legacy files to .bak (do not delete).
  await rename(configPath, configPath + '.bak');
  if (existsSync(tokensPath)) {
    await rename(tokensPath, tokensPath + '.bak');
  }

  return { config, credentials, tokensRecovered };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/vault/migrate.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/migrate.ts src/vault/migrate.test.ts
git commit -m "feat(vault): add legacy config.json/tokens.enc migration"
```

---

## Task 8: `agentio setup` command — first-time path (TDD, subprocess)

**Files:**
- Create: `src/commands/setup.ts`
- Create: `src/commands/setup.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Introduce test-only keychain injection via env var**

Before writing the setup command, we need integration tests to inject a fake keychain. Edit `src/vault/passphrase.ts` — replace the `keytarProvider()` function with this, which supports `AGENTIO_KEYCHAIN=memory:<path>` for tests:

```typescript
function keytarProvider(): KeychainProvider {
  const test = process.env.AGENTIO_KEYCHAIN;
  if (test && test.startsWith('memory:')) {
    const path = test.slice('memory:'.length);
    return memoryFileKeychain(path);
  }
  const keytar = require('keytar');
  return {
    async get(account: string) {
      const v = await keytar.getPassword(SERVICE, account);
      return v ?? null;
    },
    async set(account: string, value: string) {
      await keytar.setPassword(SERVICE, account, value);
    },
    async delete(account: string) {
      await keytar.deletePassword(SERVICE, account);
    },
  };
}

function memoryFileKeychain(path: string): KeychainProvider {
  const fs = require('fs');
  function read(): Record<string, string> {
    if (!fs.existsSync(path)) return {};
    try { return JSON.parse(fs.readFileSync(path, 'utf-8')); } catch { return {}; }
  }
  function write(data: Record<string, string>) {
    fs.writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  }
  return {
    async get(account: string) { return read()[account] ?? null; },
    async set(account: string, value: string) { const d = read(); d[account] = value; write(d); },
    async delete(account: string) { const d = read(); delete d[account]; write(d); },
  };
}
```

- [ ] **Step 2: Write failing subprocess test for first-time setup**

Create `src/commands/setup.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';

let tempHome = '';
let keychainFile = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-setup-test-'));
  keychainFile = join(tempHome, 'keychain.json');
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  if (tempHome) await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: opts.stdin ? 'pipe' : 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_KEYCHAIN: `memory:${keychainFile}`,
      ...(opts.env ?? {}),
    },
  });
  if (opts.stdin) {
    proc.stdin!.write(opts.stdin);
    proc.stdin!.end();
  }
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('agentio setup — first-time path', () => {
  test('creates vault, pointer, and keychain entry with AGENTIO_PASSPHRASE env var', async () => {
    // Non-interactive mode: location and passphrase via env
    const defaultVault = join(tempHome, '.config', 'agentio', 'vault.enc');
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: defaultVault,
        AGENTIO_SETUP_PASSPHRASE: 'test-passphrase-12345',
      },
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(defaultVault)).toBe(true);
    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.path'))).toBe(true);
    const pointer = (await readFile(join(tempHome, '.config', 'agentio', 'vault.path'), 'utf-8')).trim();
    expect(pointer).toBe(defaultVault);
    const kc = JSON.parse(await readFile(keychainFile, 'utf-8'));
    expect(kc.vault).toBe('test-passphrase-12345');
  });

  test('refuses to run if passphrase shorter than 8 chars', async () => {
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: join(tempHome, '.config', 'agentio', 'vault.enc'),
        AGENTIO_SETUP_PASSPHRASE: 'short',
      },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('passphrase');
  });

  test('refuses non-absolute vault path', async () => {
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: 'relative/vault.enc',
        AGENTIO_SETUP_PASSPHRASE: 'test-passphrase-12345',
      },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('absolute');
  });
});
```

**Why env-var-driven non-interactive mode?** Subprocess integration tests can't reliably drive `@inquirer/prompts` over stdin. Add a non-interactive fast path that reads all inputs from env vars, gated by `AGENTIO_SETUP_NONINTERACTIVE=1`. Real users always use the interactive path.

- [ ] **Step 3: Run tests — expect FAIL**

Run: `bun test src/commands/setup.test.ts`
Expected: fail with "Unknown command 'setup'" or similar.

- [ ] **Step 4: Implement `src/commands/setup.ts` (first-time path only)**

Create `src/commands/setup.ts`:

```typescript
import { Command } from 'commander';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { password, input, confirm } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { writePointer } from '../vault/pointer';
import { saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import { setPassphrase } from '../vault/passphrase';

const MIN_PASSPHRASE_LEN = 8;

interface NonInteractiveInputs {
  vaultPath: string;
  passphrase: string;
}

function readNonInteractiveInputs(): NonInteractiveInputs | null {
  if (process.env.AGENTIO_SETUP_NONINTERACTIVE !== '1') return null;
  return {
    vaultPath: process.env.AGENTIO_SETUP_VAULT_PATH ?? '',
    passphrase: process.env.AGENTIO_SETUP_PASSPHRASE ?? '',
  };
}

function validateInputs(v: NonInteractiveInputs): void {
  if (!isAbsolute(v.vaultPath)) {
    throw new CliError('INVALID_PARAMS', 'Vault path must be absolute', 'Use a path like /Users/you/agentio.vault');
  }
  if (v.passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError('INVALID_PARAMS', `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`);
  }
}

async function promptFirstTime(): Promise<NonInteractiveInputs> {
  const defaultPath = join(homedir(), '.config', 'agentio', 'vault.enc');
  const vaultPath = await input({
    message: 'Vault file location:',
    default: defaultPath,
    validate: (v) => isAbsolute(v) || 'Path must be absolute',
  });
  const passphrase = await password({
    message: 'Create a passphrase (min 8 chars):',
    mask: true,
    validate: (v) => v.length >= MIN_PASSPHRASE_LEN || `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`,
  });
  const confirmPw = await password({
    message: 'Confirm passphrase:',
    mask: true,
  });
  if (passphrase !== confirmPw) {
    throw new CliError('INVALID_PARAMS', 'Passphrases do not match');
  }
  return { vaultPath, passphrase };
}

async function doFirstTimeSetup(inputs: NonInteractiveInputs): Promise<void> {
  validateInputs(inputs);

  // Ensure parent dir exists
  const dir = dirname(inputs.vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Write pointer first so saveVault can resolve it
  await writePointer(inputs.vaultPath);

  // Stash passphrase in env for this process so saveVault's getPassphrase resolves it
  // (we also write to keychain below).
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: { profiles: {} },
    credentials: {},
  });

  // Persist passphrase to keychain
  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase in OS keychain: ${(err as Error).message}`);
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }

  console.log(`Vault created at ${inputs.vaultPath}`);
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Initialize or manage the agentio vault')
    .action(async () => {
      try {
        const nonInteractive = readNonInteractiveInputs();
        const inputs = nonInteractive ?? (await promptFirstTime());
        await doFirstTimeSetup(inputs);
      } catch (error) {
        handleError(error);
      }
    });
}
```

- [ ] **Step 5: Register `setup` in `src/index.ts`**

Edit `src/index.ts`:
1. Add import alongside other command imports:

```typescript
import { registerSetupCommand } from './commands/setup';
```

2. Register it before `registerStatusCommand(program)`:

```typescript
registerSetupCommand(program);
```

- [ ] **Step 6: Run tests — expect PASS**

Run: `bun test src/commands/setup.test.ts`
Expected: all 3 first-time tests pass.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/vault/passphrase.ts src/commands/setup.ts src/commands/setup.test.ts src/index.ts
git commit -m "feat(setup): add first-time setup path"
```

---

## Task 9: `agentio setup` — migration path (TDD)

**Files:**
- Modify: `src/commands/setup.ts`
- Modify: `src/commands/setup.test.ts`

- [ ] **Step 1: Add failing tests for migration path**

Append to `src/commands/setup.test.ts`:

```typescript
import { createCipheriv, scryptSync, randomBytes } from 'crypto';
import { hostname, userInfo } from 'os';

function legacyMachineKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-agentio-v1`;
  return scryptSync(machineId, 'agentio-salt', 32);
}

function writeLegacyTokensEnc(path: string, data: object): void {
  const key = legacyMachineKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  require('fs').writeFileSync(
    path,
    JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') }),
    { mode: 0o600 }
  );
}

describe('agentio setup — migration path', () => {
  test('migrates legacy config.json and tokens.enc into vault', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    const legacyTokensPath = join(cfgDir, 'tokens.enc');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });
    writeLegacyTokensEnc(legacyTokensPath, { gmail: { work: { token: 'xyz' } } });

    const vaultPath = join(cfgDir, 'vault.enc');
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'migration-pw-123',
        AGENTIO_SETUP_MIGRATE: 'yes',
      },
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(vaultPath)).toBe(true);
    expect(existsSync(legacyConfigPath)).toBe(false);
    expect(existsSync(legacyConfigPath + '.bak')).toBe(true);
    expect(existsSync(legacyTokensPath + '.bak')).toBe(true);

    // Verify: run `agentio status --json` and check the profile came over
    const status = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'migration-pw-123' },
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('work');
  });

  test('migration with undecryptable tokens.enc still imports config', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    const legacyTokensPath = join(cfgDir, 'tokens.enc');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });
    // tokens.enc with random key — undecryptable
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
    const enc = Buffer.concat([cipher.update('{}', 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    await writeFile(
      legacyTokensPath,
      JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') }),
      { mode: 0o600 }
    );

    const vaultPath = join(cfgDir, 'vault.enc');
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'migration-pw-123',
        AGENTIO_SETUP_MIGRATE: 'yes',
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('credentials could not be recovered');
  });

  test('migration declined with AGENTIO_SETUP_MIGRATE=no starts fresh', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });

    const vaultPath = join(cfgDir, 'vault.enc');
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'migration-pw-123',
        AGENTIO_SETUP_MIGRATE: 'no',
      },
    });
    expect(res.exitCode).toBe(0);
    // Legacy file untouched (not renamed) when user declines migration
    expect(existsSync(legacyConfigPath)).toBe(true);
    expect(existsSync(legacyConfigPath + '.bak')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/commands/setup.test.ts`
Expected: the 3 new migration tests fail (setup doesn't detect legacy yet).

- [ ] **Step 3: Wire migration detection and path into `setup.ts`**

Edit `src/commands/setup.ts`. Add imports at the top:

```typescript
import { detectLegacy, migrateLegacy } from '../vault/migrate';
```

Add a new helper function before `registerSetupCommand`:

```typescript
async function doMigrationSetup(inputs: NonInteractiveInputs): Promise<void> {
  validateInputs(inputs);
  const dir = dirname(inputs.vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const result = await migrateLegacy();

  await writePointer(inputs.vaultPath);
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: result.config,
    credentials: result.credentials,
  });

  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase in OS keychain: ${(err as Error).message}`);
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }

  console.log(`Vault created at ${inputs.vaultPath}`);
  if (!result.tokensRecovered) {
    console.error('Warning: legacy credentials could not be recovered. Re-authenticate each service.');
  }
}
```

Modify the `action` handler to detect legacy before deciding which path to run:

```typescript
    .action(async () => {
      try {
        const legacy = await detectLegacy();
        const nonInteractive = readNonInteractiveInputs();

        if (legacy.hasConfig) {
          // Ask whether to migrate
          let migrate: boolean;
          if (nonInteractive) {
            migrate = process.env.AGENTIO_SETUP_MIGRATE === 'yes';
          } else {
            migrate = await confirm({
              message: 'Found legacy config. Import into new vault?',
              default: true,
            });
          }
          if (migrate) {
            const inputs = nonInteractive ?? (await promptFirstTime());
            await doMigrationSetup(inputs);
            return;
          }
        }

        const inputs = nonInteractive ?? (await promptFirstTime());
        await doFirstTimeSetup(inputs);
      } catch (error) {
        handleError(error);
      }
    });
```

- [ ] **Step 4: Run tests — expect PASS (migration cases)**

Run: `bun test src/commands/setup.test.ts`
Expected: all setup tests (first-time + migration) pass.

Note: the migration test that calls `agentio status --json` requires `status` to work against a vault-backed config. That cutover happens in Task 12. Until then, skip the status assertion OR run this test again after Task 12. Mark it `.todo` for now:

Replace `test('migrates legacy config.json...'` with `test.todo('migrates legacy config.json and tokens.enc into vault', ...)` and remove the `.todo` in Task 12.

Re-run tests to confirm the other two migration tests pass:
Run: `bun test src/commands/setup.test.ts`
Expected: 5 passing, 1 todo.

- [ ] **Step 5: Commit**

```bash
git add src/commands/setup.ts src/commands/setup.test.ts
git commit -m "feat(setup): add migration path from legacy config/tokens"
```

---

## Task 10: `agentio setup` — adopt-existing and existing-vault menu and --reset

**Files:**
- Modify: `src/commands/setup.ts`
- Modify: `src/commands/setup.test.ts`

- [ ] **Step 1: Add failing tests for adopt-existing, change-passphrase, move-vault, and reset**

Append to `src/commands/setup.test.ts`:

```typescript
import { encryptVault } from '../vault/crypto';

describe('agentio setup — adopt existing vault', () => {
  test('prompts for passphrase of an existing vault file and writes pointer + keychain', async () => {
    // Pre-create a vault file at a custom path with a known passphrase
    const vaultPath = join(tempHome, 'dropbox', 'myvault.enc');
    await mkdir(dirname(vaultPath), { recursive: true });
    const payload = JSON.stringify({
      version: 1,
      config: { profiles: { gmail: [{ name: 'imported' }] } },
      credentials: {},
    });
    await writeFile(vaultPath, encryptVault(payload, 'adopt-pw-12345'));

    // No pointer exists yet — this is the "adopt" case
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_ADOPT: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'adopt-pw-12345',
      },
    });
    expect(res.exitCode).toBe(0);

    const kc = JSON.parse(await readFile(keychainFile, 'utf-8'));
    expect(kc.vault).toBe('adopt-pw-12345');
    const pointer = (await readFile(join(tempHome, '.config', 'agentio', 'vault.path'), 'utf-8')).trim();
    expect(pointer).toBe(vaultPath);
  });

  test('rejects wrong passphrase when adopting', async () => {
    const vaultPath = join(tempHome, 'myvault.enc');
    await writeFile(
      vaultPath,
      encryptVault(JSON.stringify({ version: 1, config: { profiles: {} }, credentials: {} }), 'right-pw')
    );
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_ADOPT: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'wrong-pw',
      },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('passphrase');
  });
});

async function preSetupVault(passphrase: string): Promise<string> {
  const vaultPath = join(tempHome, '.config', 'agentio', 'vault.enc');
  await runCli(['setup'], {
    env: {
      AGENTIO_SETUP_NONINTERACTIVE: '1',
      AGENTIO_SETUP_VAULT_PATH: vaultPath,
      AGENTIO_SETUP_PASSPHRASE: passphrase,
    },
  });
  return vaultPath;
}

describe('agentio setup — existing vault menu', () => {
  test('change passphrase re-encrypts vault and updates keychain', async () => {
    await preSetupVault('old-pw-12345');

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_MENU: 'change-passphrase',
        AGENTIO_SETUP_PASSPHRASE: 'new-pw-67890',
      },
    });
    expect(res.exitCode).toBe(0);

    const kc = JSON.parse(await readFile(keychainFile, 'utf-8'));
    expect(kc.vault).toBe('new-pw-67890');

    // Old passphrase no longer works — verify by running a command with it
    const res2 = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'old-pw-12345' },
    });
    expect(res2.exitCode).not.toBe(0);

    const res3 = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'new-pw-67890' },
    });
    expect(res3.exitCode).toBe(0);
  });

  test('move vault copies file to new location and updates pointer', async () => {
    const originalPath = await preSetupVault('pw-12345');
    const newPath = join(tempHome, 'relocated.enc');

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_MENU: 'move-vault',
        AGENTIO_SETUP_VAULT_PATH: newPath,
      },
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(originalPath)).toBe(false);
    const pointer = (await readFile(join(tempHome, '.config', 'agentio', 'vault.path'), 'utf-8')).trim();
    expect(pointer).toBe(newPath);
  });
});

describe('agentio setup --reset', () => {
  test('wipes vault, pointer, and keychain entry', async () => {
    const vaultPath = await preSetupVault('pw-12345');

    const res = await runCli(['setup', '--reset', '--force']);
    expect(res.exitCode).toBe(0);
    expect(existsSync(vaultPath)).toBe(false);
    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.path'))).toBe(false);
    const kcRaw = existsSync(keychainFile) ? await readFile(keychainFile, 'utf-8') : '{}';
    const kc = JSON.parse(kcRaw || '{}');
    expect(kc.vault).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/commands/setup.test.ts`
Expected: the new tests fail; old tests still pass.

- [ ] **Step 3: Implement adopt-existing, existing-vault menu, and reset**

Edit `src/commands/setup.ts`. Add imports:

```typescript
import { copyFile, rename, unlink } from 'fs/promises';
import { readPointer, pointerExists } from '../vault/pointer';
import { vaultExists, loadVault, saveVault as saveExistingVault, resetVault } from '../vault/vault';
import { decryptVault } from '../vault/crypto';
import { clearPassphrase, clearPassphraseCache } from '../vault/passphrase';
```

Add these helper functions before `registerSetupCommand`:

```typescript
async function doAdoptExisting(inputs: NonInteractiveInputs): Promise<void> {
  if (!isAbsolute(inputs.vaultPath)) {
    throw new CliError('INVALID_PARAMS', 'Vault path must be absolute');
  }
  if (!existsSync(inputs.vaultPath)) {
    throw new CliError('NOT_FOUND', `No vault file at ${inputs.vaultPath}`);
  }

  const encoded = await (await import('fs/promises')).readFile(inputs.vaultPath, 'utf-8');
  try {
    decryptVault(encoded.trim(), inputs.passphrase);
  } catch {
    throw new CliError('AUTH_FAILED', 'Wrong passphrase for the vault file');
  }

  await writePointer(inputs.vaultPath);
  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase in OS keychain: ${(err as Error).message}`);
  }
  console.log(`Adopted vault at ${inputs.vaultPath}`);
}

async function doChangePassphrase(newPassphrase: string): Promise<void> {
  if (newPassphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError('INVALID_PARAMS', `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`);
  }
  // Decrypt with current passphrase (from keychain/env)
  const current = await loadVault();
  // Re-encrypt with new passphrase
  process.env.AGENTIO_PASSPHRASE = newPassphrase;
  clearPassphraseCache();
  await saveExistingVault(current);
  try {
    await setPassphrase(newPassphrase);
  } catch (err) {
    console.error(`Warning: could not update keychain: ${(err as Error).message}`);
  }
  console.log('Passphrase changed');
}

async function doMoveVault(newPath: string): Promise<void> {
  if (!isAbsolute(newPath)) {
    throw new CliError('INVALID_PARAMS', 'New path must be absolute');
  }
  const current = await readPointer();
  if (!current) throw new CliError('VAULT_NOT_CONFIGURED', 'No vault to move');
  if (newPath === current) {
    console.log('Vault is already at that path');
    return;
  }

  const dir = dirname(newPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Copy → verify → repoint → delete old
  await copyFile(current, newPath);
  const encoded = await (await import('fs/promises')).readFile(newPath, 'utf-8');
  // Just verify it's readable and decryptable with the current passphrase
  const pw = process.env.AGENTIO_PASSPHRASE || '';
  // If env is not set, loadVault will resolve via keychain for us — easier:
  // re-point first, then try to load, then rollback on failure.
  const oldPointer = current;
  await writePointer(newPath);
  try {
    await loadVault();
  } catch (err) {
    // Roll back
    await writePointer(oldPointer);
    if (existsSync(newPath)) await unlink(newPath).catch(() => {});
    throw err;
  }

  await unlink(oldPointer).catch(() => {});
  console.log(`Vault moved to ${newPath}`);
}

async function doReset(force: boolean): Promise<void> {
  if (!force) {
    const ok = await confirm({
      message: 'This will delete the vault, pointer, and keychain entry. Continue?',
      default: false,
    });
    if (!ok) {
      console.error('Aborted');
      return;
    }
  }
  // Also clean legacy .bak files
  const cfgDir = join(homedir(), '.config', 'agentio');
  for (const name of ['config.json.bak', 'tokens.enc.bak']) {
    const p = join(cfgDir, name);
    if (existsSync(p)) {
      await unlink(p).catch(() => {});
    }
  }
  await resetVault();
  console.log('Vault reset. Run agentio setup to start fresh.');
}
```

Replace the `action` handler to dispatch based on state and options:

```typescript
  program
    .command('setup')
    .description('Initialize or manage the agentio vault')
    .option('--reset', 'Wipe vault, pointer, and keychain entry')
    .option('--force', 'Skip confirmation prompts (for --reset)')
    .action(async (options) => {
      try {
        if (options.reset) {
          await doReset(options.force === true);
          return;
        }

        const nonInteractive = readNonInteractiveInputs();
        const existing = await vaultExists();

        if (existing) {
          // Existing-vault menu
          let choice: 'change-passphrase' | 'move-vault' | 'cancel';
          if (nonInteractive) {
            const menu = process.env.AGENTIO_SETUP_MENU;
            if (menu !== 'change-passphrase' && menu !== 'move-vault' && menu !== 'cancel') {
              throw new CliError('INVALID_PARAMS', 'AGENTIO_SETUP_MENU must be change-passphrase|move-vault|cancel');
            }
            choice = menu;
          } else {
            choice = (await (async () => {
              const { select } = await import('@inquirer/prompts');
              return select<'change-passphrase' | 'move-vault' | 'cancel'>({
                message: 'Vault is already configured. What would you like to do?',
                choices: [
                  { name: 'Change passphrase', value: 'change-passphrase' },
                  { name: 'Move vault to a new location', value: 'move-vault' },
                  { name: 'Cancel', value: 'cancel' },
                ],
              });
            })());
          }

          if (choice === 'cancel') return;
          if (choice === 'change-passphrase') {
            const newPw = nonInteractive
              ? nonInteractive.passphrase
              : await password({
                  message: 'New passphrase:',
                  mask: true,
                  validate: (v) => v.length >= MIN_PASSPHRASE_LEN || `Minimum ${MIN_PASSPHRASE_LEN} chars`,
                });
            await doChangePassphrase(newPw);
            return;
          }
          if (choice === 'move-vault') {
            const newPath = nonInteractive
              ? nonInteractive.vaultPath
              : await input({
                  message: 'New vault path:',
                  validate: (v) => isAbsolute(v) || 'Must be absolute',
                });
            await doMoveVault(newPath);
            return;
          }
        }

        // No vault configured yet — could be adopt-existing, migration, or first-time
        const adoptMode =
          (nonInteractive && process.env.AGENTIO_SETUP_ADOPT === '1') ||
          (!nonInteractive && (await pointerExists()) === false &&
            /* interactive: ask user if they have an existing vault file */
            (await confirm({ message: 'Do you already have an existing vault file to adopt?', default: false })));

        if (adoptMode) {
          const inputs = nonInteractive ?? {
            vaultPath: await input({ message: 'Path to existing vault file:', validate: (v) => isAbsolute(v) || 'Must be absolute' }),
            passphrase: await password({ message: 'Vault passphrase:', mask: true }),
          };
          await doAdoptExisting(inputs);
          return;
        }

        const legacy = await detectLegacy();
        if (legacy.hasConfig) {
          let migrate: boolean;
          if (nonInteractive) {
            migrate = process.env.AGENTIO_SETUP_MIGRATE === 'yes';
          } else {
            migrate = await confirm({
              message: 'Found legacy config. Import into new vault?',
              default: true,
            });
          }
          if (migrate) {
            const inputs = nonInteractive ?? (await promptFirstTime());
            await doMigrationSetup(inputs);
            return;
          }
        }

        const inputs = nonInteractive ?? (await promptFirstTime());
        await doFirstTimeSetup(inputs);
      } catch (error) {
        handleError(error);
      }
    });
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/commands/setup.test.ts`
Expected: all adopt/menu/reset tests pass. The "change passphrase" test that calls `agentio status --json` and the migration test still require the facade refactor; mark those with `.todo` and they'll be re-enabled in Task 12.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/setup.ts src/commands/setup.test.ts
git commit -m "feat(setup): add adopt-existing, existing-vault menu, and --reset"
```

---

## Task 11: Command gating preAction hook (TDD)

**Files:**
- Create: `src/commands/gating.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/commands/gating.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tempHome = '';
let keychainFile = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-gating-test-'));
  keychainFile = join(tempHome, 'keychain.json');
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_KEYCHAIN: `memory:${keychainFile}`,
    },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('command gating', () => {
  test('service command fails with VAULT_NOT_CONFIGURED when no vault', async () => {
    const res = await runCli(['gmail', 'list']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('VAULT_NOT_CONFIGURED');
  });

  test('--help bypasses gate', async () => {
    const res = await runCli(['--help']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage');
  });

  test('--version bypasses gate', async () => {
    const res = await runCli(['--version']);
    expect(res.exitCode).toBe(0);
  });

  test('docs bypasses gate', async () => {
    const res = await runCli(['docs']);
    expect(res.exitCode).toBe(0);
  });

  test('setup bypasses gate', async () => {
    const res = await runCli(['setup', '--help']);
    expect(res.exitCode).toBe(0);
  });

  test('update bypasses gate', async () => {
    const res = await runCli(['update', '--help']);
    expect(res.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `bun test src/commands/gating.test.ts`
Expected: the "service command fails" test fails (probably succeeds or fails for wrong reason); bypass tests may already pass.

- [ ] **Step 3: Add the preAction hook in `src/index.ts`**

Edit `src/index.ts`. After all `register*` calls and before `program.parse()`, add:

```typescript
import { vaultExists } from './vault/vault';

const BYPASS_COMMANDS = new Set(['setup', 'docs', 'update']);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  // Bypass list: setup, docs, update. --help/--version don't run preAction hooks.
  const name = actionCommand.name();
  const parent = actionCommand.parent?.name();
  // Top-level bypass commands OR any subcommand of a bypass command.
  if (BYPASS_COMMANDS.has(name) || (parent && BYPASS_COMMANDS.has(parent))) {
    return;
  }

  if (!(await vaultExists())) {
    console.error('Error [VAULT_NOT_CONFIGURED]: No vault configured');
    console.error('Suggestion: Run: agentio setup');
    process.exit(2);
  }
});
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test src/commands/gating.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/commands/gating.test.ts
git commit -m "feat(vault): gate commands on vault existence via preAction hook"
```

---

## Task 12: Cut over config-manager and token-store to the vault

**Files:**
- Modify: `src/config/config-manager.ts`
- Modify: `src/auth/token-store.ts`
- Modify: `src/commands/config-import.test.ts`
- Modify: `src/commands/setup.test.ts` (un-todo the cases that need the cutover)

This is the most dangerous task — a refactor that changes the file of record for config + credentials. Existing tests must keep passing.

- [ ] **Step 1: Update `config-manager.ts` to delegate to the vault**

Replace the body of `src/config/config-manager.ts` (keeping the same exports):

```typescript
import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { loadVault, saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import type { Config, ServiceName, ProfileEntry, ProfileValue } from '../types/config';

const CONFIG_DIR = join(homedir(), '.config', 'agentio');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json'); // kept for backward-compat imports elsewhere

const ALL_SERVICES: ServiceName[] = ['gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'github', 'jira', 'slack', 'telegram', 'whatsapp', 'discourse', 'sql'];

function normalizeProfile(entry: ProfileValue): ProfileEntry {
  return typeof entry === 'string' ? { name: entry } : entry;
}

function getProfileName(entry: ProfileValue): string {
  return typeof entry === 'string' ? entry : entry.name;
}

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(): Promise<Config> {
  const vault = await loadVault();
  return vault.config;
}

export async function saveConfig(config: Config): Promise<void> {
  const vault = await loadVault();
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config,
    credentials: vault.credentials,
  });
}

// All the remaining helpers (getProfile, resolveProfile, setProfile, removeProfile,
// listProfiles, getEnv, setEnv, unsetEnv, listEnv, isProfileReadOnly, setProfileReadOnly)
// are unchanged — they only call loadConfig/saveConfig and operate on the Config shape.
// KEEP their existing bodies from the current file.

// ... (paste the original implementations of those helpers here, verbatim) ...

export { CONFIG_DIR, CONFIG_FILE };
```

Copy the bodies of `getProfile`, `resolveProfile`, `setProfile`, `removeProfile`, `listProfiles`, `getEnv`, `setEnv`, `unsetEnv`, `listEnv`, `isProfileReadOnly`, `setProfileReadOnly`, and the `SetProfileOptions` interface from the current file. Only the top (constants + `loadConfig`/`saveConfig`) changes.

- [ ] **Step 2: Update `token-store.ts` to delegate to the vault**

Replace the body of `src/auth/token-store.ts`:

```typescript
import { loadVault, saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import type { StoredCredentials } from '../types/tokens';
import type { ServiceName } from '../types/config';

async function loadCredentials(): Promise<StoredCredentials> {
  const vault = await loadVault();
  return vault.credentials;
}

async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  const vault = await loadVault();
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: vault.config,
    credentials,
  });
}

export async function getCredentials<T = Record<string, unknown>>(
  service: ServiceName,
  profile: string
): Promise<T | null> {
  const credentials = await loadCredentials();
  return (credentials[service]?.[profile] as T) || null;
}

export async function setCredentials(
  service: ServiceName,
  profile: string,
  data: object
): Promise<void> {
  const credentials = await loadCredentials();
  if (!credentials[service]) credentials[service] = {};
  credentials[service][profile] = data as Record<string, unknown>;
  await saveCredentials(credentials);
}

export async function removeCredentials(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const credentials = await loadCredentials();
  if (!credentials[service]?.[profile]) return false;
  delete credentials[service][profile];
  await saveCredentials(credentials);
  return true;
}

export async function hasCredentials(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const credentials = await loadCredentials();
  return !!credentials[service]?.[profile];
}

export async function getAllCredentials(): Promise<StoredCredentials> {
  return loadCredentials();
}

export async function setAllCredentials(credentials: StoredCredentials): Promise<void> {
  return saveCredentials(credentials);
}
```

- [ ] **Step 3: Add `seedVault` test helper**

Existing integration tests write `config.json` directly. After the cutover, they must seed a vault instead. Create `src/vault/test-helpers.ts`:

```typescript
import { writePointer } from './pointer';
import { saveVault, CURRENT_VAULT_VERSION } from './vault';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

/**
 * Test helper: creates a vault at `<HOME>/.config/agentio/vault.enc` pre-populated
 * with the given config and credentials, using AGENTIO_PASSPHRASE from the
 * environment (or a default test passphrase). Must be called inside a test with
 * HOME pointing at a temp dir.
 */
export async function seedVault(options: {
  config?: Config;
  credentials?: StoredCredentials;
  passphrase?: string;
  vaultPath?: string;
} = {}): Promise<{ passphrase: string; vaultPath: string }> {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const vaultPath = options.vaultPath ?? join(homedir(), '.config', 'agentio', 'vault.enc');
  const passphrase = options.passphrase ?? 'test-passphrase-1234';
  const { mkdir } = await import('fs/promises');
  const { existsSync } = await import('fs');
  const { dirname } = await import('path');
  if (!existsSync(dirname(vaultPath))) {
    await mkdir(dirname(vaultPath), { recursive: true, mode: 0o700 });
  }
  await writePointer(vaultPath);
  process.env.AGENTIO_PASSPHRASE = passphrase;
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: options.config ?? { profiles: {} },
    credentials: options.credentials ?? {},
  });
  return { passphrase, vaultPath };
}
```

- [ ] **Step 4: Update `config-import.test.ts` to use the vault**

The existing test writes `config.json` and expects `config export` to read it, then `config import` writes it back. After the cutover, both sides talk to the vault. Edit `src/commands/config-import.test.ts`:

1. Replace `writeConfig` with a helper that writes the vault instead. This needs to happen out-of-process (test needs to set up state before spawning the subprocess), so we spawn `agentio setup` in non-interactive mode once per test.

2. Update the `beforeEach` to set up a vault with the given initial state:

```typescript
async function setupVaultWith(config: Record<string, unknown>): Promise<void> {
  const vaultPath = join(tempHome, '.config', 'agentio', 'vault.enc');
  const res = await runCli(['setup'], {
    AGENTIO_SETUP_NONINTERACTIVE: '1',
    AGENTIO_SETUP_VAULT_PATH: vaultPath,
    AGENTIO_SETUP_PASSPHRASE: 'test-pw-12345',
  });
  if (res.exitCode !== 0) {
    throw new Error(`setup failed: ${res.stderr}`);
  }
  // Now overwrite the vault content by spawning a small Bun script that
  // imports saveVault and writes the target config.
  await runCli(['config', 'import', '--merge'], {
    AGENTIO_PASSPHRASE: 'test-pw-12345',
    // Use the existing import flow with a fresh export-style blob OR
    // write directly via an inline script.
  });
  // Simpler approach: keep a single `test-seed` internal command? No — use a
  // Bun.spawn subprocess that imports seedVault directly:
  const seed = Bun.spawn(['bun', 'run', '-e', `
    import { seedVault } from '../../src/vault/test-helpers';
    await seedVault({ config: ${JSON.stringify(config)}, passphrase: 'test-pw-12345', vaultPath: '${vaultPath}' });
  `], {
    env: { ...process.env, HOME: tempHome, AGENTIO_KEYCHAIN: `memory:${join(tempHome, 'keychain.json')}` },
  });
  await seed.exited;
}
```

**Reality-check:** The inline `-e` script above is awkward. Simpler: expose the seed helper as a hidden CLI command or use direct in-process calls.

**Concrete choice:** Use in-process calls. Because the test already uses a temp `HOME`, we can import `seedVault` directly in the test file and call it. The only catch is `homedir()` is cached in some modules — but `seedVault` reads `homedir()` lazily, so setting `process.env.HOME = tempHome` in `beforeEach` before calling `seedVault()` works.

Revised approach — add to `src/commands/config-import.test.ts`:

```typescript
import { seedVault } from '../vault/test-helpers';

// Replace writeConfig with:
async function seedConfig(config: Record<string, unknown>): Promise<void> {
  process.env.HOME = tempHome;
  await seedVault({ config: config as any, passphrase: 'test-pw-12345' });
  // Ensure subprocess uses the same passphrase
}

// Anywhere runCli() is called, ensure env includes:
//   AGENTIO_PASSPHRASE: 'test-pw-12345',
//   AGENTIO_KEYCHAIN: `memory:${join(tempHome, 'keychain.json')}`,
```

Update `runCli` env block:

```typescript
env: {
  ...process.env,
  HOME: tempHome,
  AGENTIO_PASSPHRASE: 'test-pw-12345',
  AGENTIO_KEYCHAIN: `memory:${join(tempHome, 'keychain.json')}`,
  ...extraEnv,
},
```

Replace every `await writeConfig({...})` with `await seedConfig({...})`.

Replace `readConfig()` to decrypt the vault instead of reading `config.json`:

```typescript
async function readConfig(): Promise<Record<string, unknown>> {
  // Read the vault back via `agentio docs` or a utility? Simpler: use loadVault
  // in-process now that HOME is set.
  process.env.HOME = tempHome;
  process.env.AGENTIO_PASSPHRASE = 'test-pw-12345';
  // Invalidate the vault cache from prior call:
  const { clearVaultCache, loadVault } = await import('../vault/vault');
  clearVaultCache();
  const v = await loadVault();
  return v.config as unknown as Record<string, unknown>;
}
```

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all tests pass. Fix any import-path or environment issues revealed by this cutover.

- [ ] **Step 6: Un-todo the tests marked in Task 9 and Task 10**

Change `test.todo(...)` back to `test(...)` for:
- The migration test that checks `agentio status --json` output.
- The "change passphrase" test that runs `agentio status --json`.

Run: `bun test`
Expected: now green.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(vault): cut over config-manager and token-store to use the vault"
```

---

## Task 13: Cleanup — reuse `src/vault/crypto.ts` in `src/commands/config.ts`

**Files:**
- Modify: `src/commands/config.ts`

- [ ] **Step 1: Remove the duplicated encrypt/decrypt helpers**

Edit `src/commands/config.ts`:

1. Remove the local `ALGORITHM` constant, `encrypt`, `decrypt`, and `deriveKeyFromPassword` functions.
2. Remove the imports from `crypto`: `createCipheriv`, `createDecipheriv`, `randomBytes`, `scryptSync`.
3. Keep `generateKey` (still used for random-key mode).
4. Replace calls to `encrypt(data, deriveKeyFromPassword(key))` with `encryptVault(data, key)`.
5. Replace calls to `decrypt(encrypted, deriveKeyFromPassword(key))` with `decryptVault(encrypted, key)`.
6. Add: `import { encryptVault, decryptVault } from '../vault/crypto';`.

**Note on format compatibility:** The old config.ts `encrypt`/`decrypt` used a hard-coded salt (`'agentio-export-salt'`) and layout `base64(iv || ciphertext || tag)` — no salt in the payload. The new `encryptVault`/`decryptVault` uses a random per-encryption salt stored in the payload: `base64(salt || iv || ciphertext || tag)`.

**This is a breaking change for the export/import format.** Old exports from previous agentio versions will not decrypt with the new code. Options:

1. Keep the old `encrypt`/`decrypt` inline in `config.ts` and accept duplication (lowest risk).
2. Bump the export format: `config export` emits the new layout, `config import` accepts both (detect by length: 32-byte salt prefix means new format). A bit more code.
3. Break compatibility and document it.

**Recommendation:** Option (2). Append to `config.ts`:

```typescript
// Detect legacy export blobs (no salt prefix) and handle them separately
// so users with existing AGENTIO_CONFIG env vars keep working.
function isLegacyExportBlob(encoded: string): boolean {
  try {
    const buf = Buffer.from(encoded, 'base64');
    // legacy layout: iv(16) + ciphertext + tag(16); minimum 33 bytes but
    // typically much larger. New layout starts with 32 bytes of random salt
    // so lengths of (legacy + 32) would match, but we can't distinguish purely
    // by length. Use a version marker instead.
    return buf.length < 65; // heuristic fallback
  } catch { return false; }
}
```

Actually this heuristic is fragile. Simpler choice: **cleanly break** export/import compatibility. Users re-export after upgrade. Document in the commit message. This is a tool with a small user base and the export blobs are designed to be short-lived CI secrets.

**Final decision:** break compatibility. Remove the duplicated helpers, use `encryptVault`/`decryptVault`, document the breaking change.

Update the patched `config.ts`:

```typescript
// Replace:
//   const key = deriveKeyFromPassword(encryptionKey);
//   const encrypted = encrypt(JSON.stringify(exportData), key);
// With:
const encrypted = encryptVault(JSON.stringify(exportData), encryptionKey);

// Replace:
//   const derivedKey = deriveKeyFromPassword(key);
//   const decrypted = decrypt(encrypted.trim(), derivedKey);
// With:
const decrypted = decryptVault(encrypted.trim(), key);
```

- [ ] **Step 2: Run the export/import test**

Run: `bun test src/commands/config-import.test.ts`
Expected: all tests pass (they round-trip export→import within the same version, so the format change is invisible).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/config.ts
git commit -m "refactor(config): reuse vault crypto primitives in export/import

BREAKING: config export blob format now includes a random per-blob salt.
Old AGENTIO_CONFIG env vars produced by pre-vault agentio will not decrypt.
Re-run \`agentio config export\` to produce a new blob."
```

---

## Task 14: End-to-end smoke test

**Files:**
- Create: `src/commands/e2e.test.ts`

- [ ] **Step 1: Write the end-to-end test**

Create `src/commands/e2e.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tempHome = '';
let keychainFile = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-e2e-'));
  keychainFile = join(tempHome, 'keychain.json');
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_KEYCHAIN: `memory:${keychainFile}`,
      ...extraEnv,
    },
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe('e2e: first-install → setup → status → export → reset', () => {
  test('full happy path', async () => {
    // Gate blocks
    const r1 = await runCli(['status', '--no-test']);
    expect(r1.exitCode).not.toBe(0);
    expect(r1.stderr).toContain('VAULT_NOT_CONFIGURED');

    // Setup
    const r2 = await runCli(['setup'], {
      AGENTIO_SETUP_NONINTERACTIVE: '1',
      AGENTIO_SETUP_VAULT_PATH: join(tempHome, '.config', 'agentio', 'vault.enc'),
      AGENTIO_SETUP_PASSPHRASE: 'e2e-passphrase-12345',
    });
    expect(r2.exitCode).toBe(0);

    // Status now works — keychain-resolved passphrase
    const r3 = await runCli(['status', '--no-test']);
    expect(r3.exitCode).toBe(0);

    // Reset
    const r4 = await runCli(['setup', '--reset', '--force']);
    expect(r4.exitCode).toBe(0);

    // Gate blocks again
    const r5 = await runCli(['status', '--no-test']);
    expect(r5.exitCode).not.toBe(0);
    expect(r5.stderr).toContain('VAULT_NOT_CONFIGURED');
  });
});

describe('e2e: daemon fails fast with VAULT_LOCKED when no passphrase source', () => {
  test('gateway start without keychain or env fails cleanly', async () => {
    // Create vault with passphrase written to keychain, then simulate a
    // different subprocess environment (no keychain access, no env var).
    await runCli(['setup'], {
      AGENTIO_SETUP_NONINTERACTIVE: '1',
      AGENTIO_SETUP_VAULT_PATH: join(tempHome, '.config', 'agentio', 'vault.enc'),
      AGENTIO_SETUP_PASSPHRASE: 'daemon-pw-12345',
    });

    // Run gateway status (a read-only gateway command that needs vault)
    // with an EMPTY keychain file to simulate no cached passphrase.
    const emptyKeychain = join(tempHome, 'empty-keychain.json');
    await Bun.write(emptyKeychain, '{}');
    const res = await runCli(['gateway', 'status'], {
      AGENTIO_KEYCHAIN: `memory:${emptyKeychain}`,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('VAULT_LOCKED');

    // Now set AGENTIO_PASSPHRASE — same command should pass the gate and
    // reach actual daemon status logic.
    const res2 = await runCli(['gateway', 'status'], {
      AGENTIO_KEYCHAIN: `memory:${emptyKeychain}`,
      AGENTIO_PASSPHRASE: 'daemon-pw-12345',
    });
    // exit code may be non-zero (daemon not running) but it MUST NOT be VAULT_LOCKED
    expect(res2.stderr).not.toContain('VAULT_LOCKED');
  });
});
```

- [ ] **Step 2: Run the e2e tests**

Run: `bun test src/commands/e2e.test.ts`
Expected: both tests pass.

- [ ] **Step 3: Run the full test suite one more time**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/commands/e2e.test.ts
git commit -m "test(vault): add end-to-end smoke tests for vault lifecycle"
```

---

## Task 15: Update CLAUDE.md with the new setup flow

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a `Vault` section to CLAUDE.md**

Edit `CLAUDE.md`. Add after the existing commands reference:

```markdown
### Setup (vault)

The agentio config + credentials are stored in a single encrypted **vault** file. First-time installs must run `agentio setup` before any other command.

```bash
agentio setup                  # First-time, migration, adopt existing, or manage vault
agentio setup --reset --force  # Wipe vault, pointer, and keychain entry
```

- Vault location defaults to `~/.config/agentio/vault.enc`; a pointer file at `~/.config/agentio/vault.path` tracks the current path.
- Passphrase is stored in the OS keychain (macOS Keychain / libsecret / Windows Credential Manager). Commands read it silently.
- For headless/CI use, set `AGENTIO_PASSPHRASE` env var to bypass the keychain.
- Runtime files (`gateway.db`, `media/`, `gateway.log`) remain plaintext under `~/.config/agentio/`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document vault setup in CLAUDE.md"
```

---

## Self-Review

Checked against `docs/design/vault-encryption.md`:

- **Architecture** → Tasks 3-6 (vault module files), 8-10 (setup), 11 (gating), 12 (facade cutover). ✓
- **Vault file format (`base64(salt || iv || ciphertext || tag)`, version field)** → Task 3 (crypto), Task 6 (version assertion). ✓
- **Pointer file** → Task 4. ✓
- **Passphrase resolution chain (env → cache → keychain → fail)** → Task 5. ✓
- **No interactive prompts outside setup** → Enforced in Task 5 (`getPassphrase` never prompts); Task 8-10 keep prompts confined to `setup`. ✓
- **Setup flows (first-time / migration / adopt / menu / reset)** → Tasks 8, 9, 10. ✓
- **Migration reads legacy files directly, not through facades** → Task 7 (`migrate.ts` imports `fs`/`crypto`, not config-manager). ✓
- **Gating preAction hook + bypass list** → Task 11. ✓
- **Gateway daemon uses same chain** → Covered by `getPassphrase` in Task 5 + e2e test in Task 14. ✓
- **Error taxonomy (`VAULT_NOT_CONFIGURED`, `VAULT_LOCKED`, `VAULT_CORRUPT`, reused `AUTH_FAILED`/`CONFIG_ERROR`)** → Task 1 (codes), Task 6 (vault throws them), Task 11 (gate throws `VAULT_NOT_CONFIGURED`). ✓
- **Stale keychain detection** → Task 6 vault test + implementation. ✓
- **Atomic writes with `.tmp` + rename and cleanup on failure** → Task 6. ✓
- **Keychain write failure warns but setup succeeds** → Task 8 step 4 (`doFirstTimeSetup` catches and warns). ✓
- **Move vault: copy → verify → repoint → delete with rollback** → Task 10 `doMoveVault`. ✓
- **Reset cleans `.bak` files** → Task 10 `doReset`. ✓
- **Partial migration when tokens.enc undecryptable** → Task 7 + Task 9 test. ✓
- **Keep `config export`/`import` independent of vault** → Task 13 only replaces the shared crypto primitive; behavior is preserved; format-break documented. ✓
- **Test strategy (all automated, fake keychain via `AGENTIO_KEYCHAIN=memory:<path>`)** → Covered across Tasks 3-14. ✓

**Placeholder scan:** no "TBD"/"TODO"/"etc." in steps. Task 12 step 1 uses "paste the original implementations of those helpers here, verbatim" — this is a concrete instruction (copy lines 64-262 from the original file), not a placeholder.

**Type consistency:** `VaultContents` used consistently in Tasks 6, 7, 12. `KeychainProvider` interface consistent in Task 5 and all tests. `CURRENT_VAULT_VERSION` exported from `vault.ts` and used in Tasks 6, 7, 9, 10, 12.

**Known gaps I intentionally left:**
- No task for updating `src/commands/status.ts` to handle the new vault-backed lookup — it already calls `loadConfig`/`listProfiles` which now go through the vault; no change needed.
- No task for the README — the CLAUDE.md entry in Task 15 is sufficient; README updates are out of scope per user's global CLAUDE.md rule ("NEVER proactively create documentation files").
