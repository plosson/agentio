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
