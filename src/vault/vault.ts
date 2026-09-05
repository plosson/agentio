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
      'Vault is locked — passphrase not found',
      'Run `agentio vault set <path>` to re-store the passphrase, or set the AGENTIO_PASSPHRASE env var.'
    );
  }
  return pw;
}

export async function loadVault(): Promise<VaultContents> {
  if (cache) return cache;

  if (!(await pointerExists())) {
    throw new CliError(
      'VAULT_NOT_CONFIGURED',
      'agentio is not configured yet',
      'Run `agentio vault init` to create one, or `agentio vault set <path>` to use an existing vault.'
    );
  }
  const path = (await readPointer())!;
  if (!existsSync(path)) {
    throw new CliError(
      'CONFIG_ERROR',
      `Vault file missing at ${path}`,
      'Run `agentio vault set <path>` to point at an existing vault, or `agentio vault init` to create one'
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
      // Wipe stale passphrase file if the passphrase came from there.
      if (!passphraseFromEnv) {
        await clearPassphrase();
      }
      throw new CliError(
        'AUTH_FAILED',
        'Wrong passphrase for vault',
        'If you changed the passphrase elsewhere, run: agentio vault set <path>'
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

  cache = payload;
  return payload;
}

export async function saveVault(contents: VaultContents): Promise<void> {
  if (!(await pointerExists())) {
    throw new CliError(
      'VAULT_NOT_CONFIGURED',
      'agentio is not configured yet',
      'Run `agentio vault init` to create one, or `agentio vault set <path>` to use an existing vault.'
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
