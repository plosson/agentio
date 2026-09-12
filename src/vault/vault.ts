import { readFile, writeFile, unlink, rename, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, relative, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { CliError } from '../utils/errors';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';
import { encryptVault, decryptVault } from './crypto';
import { assertLocalMode } from '../auth/remote';
import {
  readPointer,
  pointerExists,
  deletePointer,
} from './pointer';
import {
  getPassphrase,
  clearPassphrase,
  clearPassphraseCache,
  setPassphraseInMemory,
  hasResidentPassphrase,
} from './passphrase';

export const CURRENT_VAULT_VERSION = 1;

export interface VaultContents {
  version: number;
  config: Config;
  credentials: StoredCredentials;
}

// The cache is keyed on the vault file it came from and that file's mtime, so
// a long-lived process (the daemon) notices writes made by another process, and
// a process whose pointer moves (HOME switched, `vault set` elsewhere) never
// serves one vault's contents for another's. A hit costs one stat; loadVault
// adds the pointer read that resolves the path.
let cache: VaultContents | null = null;
let cachePath: string | null = null;
let cacheMtimeMs = 0;

export function clearVaultCache(): void {
  cache = null;
  cachePath = null;
  cacheMtimeMs = 0;
}

async function setCache(contents: VaultContents, path: string): Promise<void> {
  cache = contents;
  cachePath = path;
  cacheMtimeMs = (await stat(path)).mtimeMs;
}

async function cachedIfFresh(path: string): Promise<VaultContents | null> {
  if (!cache || cachePath !== path) return null;
  try {
    if ((await stat(path)).mtimeMs === cacheMtimeMs) return cache;
  } catch {
    // File gone or unreadable: fall through to a full load, which reports it.
  }
  return null;
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
      'Vault is locked — passphrase not found',
      'Run `agentio vault set <path>` to re-store the passphrase, or set the AGENTIO_PASSPHRASE env var.'
    );
  }
  return pw;
}

/** Path from the pointer file; throws when agentio has never been configured. */
async function requireVaultPath(): Promise<string> {
  if (!(await pointerExists())) {
    throw new CliError(
      'VAULT_NOT_CONFIGURED',
      'agentio is not configured yet',
      'Run `agentio vault init` to create one, or `agentio vault set <path>` to use an existing vault.'
    );
  }
  return (await readPointer())!;
}

/** Like requireVaultPath, but the file must also exist on disk. */
async function requireExistingVaultPath(): Promise<string> {
  const path = await requireVaultPath();
  if (!existsSync(path)) {
    throw new CliError(
      'CONFIG_ERROR',
      `Vault file missing at ${path}`,
      'Run `agentio vault set <path>` to point at an existing vault, or `agentio vault init` to create one'
    );
  }
  return path;
}

/**
 * Decrypt and parse the on-disk blob. `wipeStoredPassphrase` controls whether a
 * wrong passphrase also clears the passphrase store: yes when the passphrase
 * came from the store (it is stale), no when the caller supplied it.
 */
async function decryptPayload(
  encoded: string,
  pw: string,
  wipeStoredPassphrase: boolean,
): Promise<VaultContents> {
  let plaintext: string;
  try {
    plaintext = await decryptVault(encoded.trim(), pw);
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
      if (wipeStoredPassphrase) {
        await clearPassphrase();
      }
      throw new CliError(
        'AUTH_FAILED',
        'Wrong passphrase for vault',
        wipeStoredPassphrase
          ? 'If you changed the passphrase elsewhere, run: agentio vault set <path>'
          : 'Check the passphrase you supplied (AGENTIO_PASSPHRASE or the one you entered)'
      );
    }
    throw new CliError(
      'VAULT_CORRUPT',
      'Vault file is malformed',
      'Restore from backup or run: agentio vault reset'
    );
  }

  let payload: VaultContents;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new CliError(
      'VAULT_CORRUPT',
      'Vault contents are not valid JSON',
      'Restore from backup or run: agentio vault reset'
    );
  }

  if (payload.version !== CURRENT_VAULT_VERSION) {
    throw new CliError(
      'VAULT_CORRUPT',
      `Unsupported vault version: ${payload.version}`,
      'Upgrade agentio, or restore from backup'
    );
  }

  return payload;
}

/** The contents of the vault at `path`, from cache when fresh. */
async function loadVaultAt(path: string): Promise<VaultContents> {
  const fresh = await cachedIfFresh(path);
  if (fresh) return fresh;

  const pw = await resolvePassphraseOrThrow();
  const passphraseFromEnv = !!process.env.AGENTIO_PASSPHRASE;
  const encoded = await readFile(path, 'utf-8');

  const payload = await decryptPayload(encoded, pw, !passphraseFromEnv);
  await setCache(payload, path);
  return payload;
}

export async function loadVault(): Promise<VaultContents> {
  assertLocalMode('Reading the vault');
  return loadVaultAt(await requireExistingVaultPath());
}

// Writes are serialised within the process: two callers that each loaded,
// changed, and saved would otherwise collide on the temp file and the second
// save would drop the first one's change. The daemon has many concurrent
// writers (refreshes, key touches, UI actions); updateVault is how they stay
// atomic, and saveVault joins the same queue so nothing bypasses it.
let writeQueue: Promise<unknown> = Promise.resolve();

function serializedWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => {});
  return run;
}

/**
 * Load the current contents, apply `mutate` in place to a copy, and write the
 * result, all under the write lock. The path is resolved once, up front, so
 * what was loaded is what gets written even if the pointer moves meanwhile.
 * The mutator works on a copy, so one that throws halfway leaves the cache
 * clean; one that changes nothing costs no write. Returns the mutator's result.
 */
export function updateVault<T>(mutate: (contents: VaultContents) => T | Promise<T>): Promise<T> {
  assertLocalMode('Changing the vault');
  return serializedWrite(async () => {
    const path = await requireExistingVaultPath();
    const before = JSON.stringify(await loadVaultAt(path));
    const contents: VaultContents = JSON.parse(before);
    const result = await mutate(contents);
    const after = JSON.stringify(contents);
    if (after !== before) await writeVault(contents, path, after);
    return result;
  });
}

/** Write whole contents; for creating a vault or replacing one wholesale. */
export function saveVault(contents: VaultContents): Promise<void> {
  return serializedWrite(async () => writeVault(contents, await requireVaultPath(), JSON.stringify(contents)));
}

/** Under `bun test`, a vault may only ever be written inside the OS temp directory. */
function assertWritablePath(path: string): void {
  if (process.env.NODE_ENV !== 'test') return;
  const rel = relative(tmpdir(), path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write a vault outside ${tmpdir()} during tests: ${path}`);
  }
}

async function writeVault(contents: VaultContents, path: string, plaintext: string): Promise<void> {
  assertWritablePath(path);
  const pw = await resolvePassphraseOrThrow();

  const tmp = path + '.tmp';
  const encoded = await encryptVault(plaintext, pw);

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

  await setCache(contents, path);
}

/**
 * Verify `passphrase` against the vault on disk and, if it decrypts, keep it
 * in process memory. The passphrase store is never read or written, so a
 * wrong guess changes nothing. Throws AUTH_FAILED, VAULT_CORRUPT,
 * VAULT_NOT_CONFIGURED, or CONFIG_ERROR like loadVault.
 */
export async function unlockVault(passphrase: string): Promise<void> {
  const path = await requireExistingVaultPath();
  const encoded = await readFile(path, 'utf-8');
  const payload = await decryptPayload(encoded, passphrase, false);
  setPassphraseInMemory(passphrase);
  await setCache(payload, path);
}

/** Forget the in-memory passphrase and decrypted contents. */
export function lockVault(): void {
  clearPassphraseCache();
  clearVaultCache();
}

/** True when the vault can be read without consulting the passphrase store. */
export function isVaultUnlocked(): boolean {
  return hasResidentPassphrase();
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
  lockVault();
}
