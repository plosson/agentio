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
