import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  loadVault,
  saveVault,
  vaultExists,
  resetVault,
  clearVaultCache,
  unlockVault,
  lockVault,
  isVaultUnlocked,
  updateVault,
  CURRENT_VAULT_VERSION,
} from './vault';
import {
  clearPassphraseCache,
  getPassphrase,
  memoryOnlyProvider,
  resetPassphraseProvider,
  setPassphraseProvider,
  type PassphraseProvider,
} from './passphrase';
import { writePointer, deletePointer } from './pointer';
import { encryptVault } from './crypto';

let tempHome = '';
let savedHome = '';
let vaultFile = '';

class MemoryPassphraseStore implements PassphraseProvider {
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
  const mem = new MemoryPassphraseStore();
  setPassphraseProvider(mem);
  clearPassphraseCache();
  clearVaultCache();
  delete process.env.AGENTIO_PASSPHRASE;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  resetPassphraseProvider();
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
    const encoded = await encryptVault(
      JSON.stringify({ version: 1, config: { profiles: {} }, credentials: {} }),
      'pw'
    );
    await writeFile(vaultFile, encoded);
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('loadVault throws AUTH_FAILED on wrong passphrase and wipes stale passphrase store entry', async () => {
    const mem = new MemoryPassphraseStore();
    setPassphraseProvider(mem);
    await mem.set('vault', 'wrong-pw');

    await writePointer(vaultFile);
    const encoded = await encryptVault(
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
    const encoded = await encryptVault(
      JSON.stringify({ version: 999, config: { profiles: {} }, credentials: {} }),
      'pw'
    );
    await writeFile(vaultFile, encoded);
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_CORRUPT' });
  });

  test('resetVault deletes pointer, vault file, and passphrase store entry', async () => {
    const mem = new MemoryPassphraseStore();
    setPassphraseProvider(mem);
    await mem.set('vault', 'pw');
    await writePointer(vaultFile);
    await writeFile(vaultFile, 'anything');

    await resetVault();

    expect(existsSync(vaultFile)).toBe(false);
    expect(await mem.get('vault')).toBeNull();
  });

  test('loadVault serves the cache while the file is untouched', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    await saveVault({ version: 1, config: { profiles: {} }, credentials: {} });
    const a = await loadVault();
    const b = await loadVault();
    expect(b).toBe(a);
  });

  test('loadVault picks up a rewrite made by another process', async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    await saveVault({ version: 1, config: { profiles: {} }, credentials: {} });
    await loadVault();

    // Another process writes new contents (and a new mtime).
    const external = { version: 1, config: { profiles: { gmail: [{ name: 'ext' }] } }, credentials: {} };
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(vaultFile, await encryptVault(JSON.stringify(external), 'pw'));

    expect(await loadVault()).toEqual(external);
  });
});

describe('updateVault', () => {
  beforeEach(async () => {
    process.env.AGENTIO_PASSPHRASE = 'pw';
    await writePointer(vaultFile);
    await saveVault({ version: 1, config: { profiles: {} }, credentials: {} });
  });

  test('concurrent read-modify-writes are serialised and all land', async () => {
    await Promise.all([
      updateVault((v) => { v.config.profiles.gmail = [{ name: 'a' }]; }),
      updateVault((v) => { v.credentials.gmail = { a: { token: 't' } }; }),
      updateVault((v) => { v.config.profiles.slack = [{ name: 's' }]; }),
    ]);

    clearVaultCache();
    const final = await loadVault();
    expect(final.config.profiles).toEqual({ gmail: [{ name: 'a' }], slack: [{ name: 's' }] });
    expect(final.credentials).toEqual({ gmail: { a: { token: 't' } } });
  });

  test('returns the mutator result and skips the write when nothing changed', async () => {
    const mtimeBefore = (await stat(vaultFile)).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    expect(await updateVault((v) => Object.keys(v.config.profiles).length)).toBe(0);
    expect((await stat(vaultFile)).mtimeMs).toBe(mtimeBefore);
    expect(await updateVault((v) => { v.config.profiles.gmail = [{ name: 'a' }]; return 'written'; })).toBe('written');
    expect((await stat(vaultFile)).mtimeMs).not.toBe(mtimeBefore);
  });

  test('under bun test, a vault outside the temp directory is never written', async () => {
    await writePointer('/Users/nobody/agentio/vault.enc');
    await expect(saveVault({ version: 1, config: { profiles: {} }, credentials: {} })).rejects.toThrow(/Refusing to write/);
    expect(existsSync('/Users/nobody/agentio/vault.enc')).toBe(false);
  });

  test('a mutator that throws writes nothing and does not block later writes', async () => {
    await expect(updateVault(() => { throw new Error('nope'); })).rejects.toThrow('nope');
    await updateVault((v) => { v.config.profiles.gmail = [{ name: 'after' }]; });
    clearVaultCache();
    expect((await loadVault()).config.profiles).toEqual({ gmail: [{ name: 'after' }] });
  });
});

describe('vault lock state', () => {
  const payload = { version: 1, config: { profiles: { gmail: [{ name: 'w' }] } }, credentials: {} };

  beforeEach(async () => {
    setPassphraseProvider(memoryOnlyProvider());
    await writePointer(vaultFile);
    await writeFile(vaultFile, await encryptVault(JSON.stringify(payload), 'right-pw'));
  });

  test('starts locked when neither env nor memory holds a passphrase', async () => {
    expect(isVaultUnlocked()).toBe(false);
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('unlockVault with the right passphrase makes loadVault work', async () => {
    await unlockVault('right-pw');
    expect(isVaultUnlocked()).toBe(true);
    expect(await loadVault()).toEqual(payload);
  });

  test('unlockVault with a wrong passphrase throws AUTH_FAILED and stays locked', async () => {
    await expect(unlockVault('wrong-pw')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(isVaultUnlocked()).toBe(false);
    expect(await getPassphrase()).toBeNull();
  });

  test('unlockVault never touches the passphrase store', async () => {
    const mem = new MemoryPassphraseStore();
    await mem.set('vault', 'stale-pw');
    setPassphraseProvider(mem);

    await expect(unlockVault('wrong-pw')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(await mem.get('vault')).toBe('stale-pw');

    await unlockVault('right-pw');
    expect(await mem.get('vault')).toBe('stale-pw');
  });

  test('unlockVault reports a missing vault like loadVault', async () => {
    await writePointer('/does/not/exist.enc');
    await expect(unlockVault('right-pw')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    await deletePointer();
    await expect(unlockVault('right-pw')).rejects.toMatchObject({ code: 'VAULT_NOT_CONFIGURED' });
  });

  test('lockVault forgets passphrase and contents', async () => {
    await unlockVault('right-pw');
    lockVault();
    expect(isVaultUnlocked()).toBe(false);
    await expect(loadVault()).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('AGENTIO_PASSPHRASE counts as unlocked', () => {
    process.env.AGENTIO_PASSPHRASE = 'right-pw';
    expect(isVaultUnlocked()).toBe(true);
  });
});
