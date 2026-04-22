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
