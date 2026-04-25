import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getPassphrase,
  setPassphrase,
  clearPassphrase,
  clearPassphraseCache,
  setPassphraseProvider,
  resetPassphraseProvider,
  type PassphraseProvider,
} from './passphrase';

class MemoryPassphraseStore implements PassphraseProvider {
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

let mem: MemoryPassphraseStore;

beforeEach(() => {
  mem = new MemoryPassphraseStore();
  setPassphraseProvider(mem);
  clearPassphraseCache();
  delete process.env.AGENTIO_PASSPHRASE;
});

afterEach(() => {
  resetPassphraseProvider();
  clearPassphraseCache();
  delete process.env.AGENTIO_PASSPHRASE;
});

describe('passphrase resolution', () => {
  test('env var takes precedence', async () => {
    process.env.AGENTIO_PASSPHRASE = 'from-env';
    await mem.set('vault', 'from-store');
    expect(await getPassphrase()).toBe('from-env');
  });

  test('store used when env not set', async () => {
    await mem.set('vault', 'from-store');
    expect(await getPassphrase()).toBe('from-store');
  });

  test('process cache returns same value on second call', async () => {
    await mem.set('vault', 'from-store');
    expect(await getPassphrase()).toBe('from-store');
    // Delete from store — cache should still serve
    await mem.delete('vault');
    expect(await getPassphrase()).toBe('from-store');
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

  test('setPassphrase writes to passphrase store and populates cache', async () => {
    await setPassphrase('new-pw');
    expect(await mem.get('vault')).toBe('new-pw');
    expect(await getPassphrase()).toBe('new-pw');
  });

  test('clearPassphrase wipes passphrase store and cache', async () => {
    await setPassphrase('pw');
    await clearPassphrase();
    expect(await mem.get('vault')).toBeNull();
    expect(await getPassphrase()).toBeNull();
  });

  test('passphrase store read error falls through gracefully', async () => {
    setPassphraseProvider({
      async get() { throw new Error('no libsecret'); },
      async set() { throw new Error('no libsecret'); },
      async delete() { throw new Error('no libsecret'); },
    });
    expect(await getPassphrase()).toBeNull();
  });
});
