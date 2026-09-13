import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { assertTestWritable } from './pointer';

export interface PassphraseProvider {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const ACCOUNT = 'vault';

let provider: PassphraseProvider | null = null;
let cached: string | null = null;

function passphraseFilePath(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio', 'vault.passphrase');
}

function fileProvider(): PassphraseProvider {
  return {
    async get() {
      const p = passphraseFilePath();
      if (!existsSync(p)) return null;
      try {
        return readFileSync(p, 'utf-8').replace(/\n$/, '');
      } catch {
        return null;
      }
    },
    async set(_account, value) {
      const p = passphraseFilePath();
      assertTestWritable(p, 'passphrase file');
      const dir = dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(p, value, { mode: 0o600 });
    },
    async delete() {
      const p = passphraseFilePath();
      if (existsSync(p)) {
        assertTestWritable(p, 'passphrase file');
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    },
  };
}

function memoryFileProvider(path: string): PassphraseProvider {
  function read(): Record<string, string> {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return {};
    }
  }
  function write(data: Record<string, string>) {
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  }
  return {
    async get(account) {
      return read()[account] ?? null;
    },
    async set(account, value) {
      const d = read();
      d[account] = value;
      write(d);
    },
    async delete(account) {
      const d = read();
      delete d[account];
      write(d);
    },
  };
}

/**
 * Provider that never reads or writes a store. With it installed, the
 * passphrase can only come from AGENTIO_PASSPHRASE or from
 * setPassphraseInMemory(); this is how the daemon stays locked until
 * someone unlocks it.
 */
export function memoryOnlyProvider(): PassphraseProvider {
  return {
    async get() { return null; },
    async set() { /* noop */ },
    async delete() { /* noop */ },
  };
}

function defaultProvider(): PassphraseProvider {
  const test = process.env.AGENTIO_PASSPHRASE_STORE;
  if (test && test.startsWith('memory:')) {
    return memoryFileProvider(test.slice('memory:'.length));
  }
  return fileProvider();
}

function getProvider(): PassphraseProvider {
  if (provider) return provider;
  provider = defaultProvider();
  return provider;
}

export function setPassphraseProvider(p: PassphraseProvider): void {
  provider = p;
}

export function resetPassphraseProvider(): void {
  provider = null;
}

export function clearPassphraseCache(): void {
  cached = null;
}

/** Hold the passphrase for this process only; the store is not touched. */
export function setPassphraseInMemory(passphrase: string): void {
  cached = passphrase;
}

/** True when a passphrase resolves without consulting the store. */
export function hasResidentPassphrase(): boolean {
  return Boolean(process.env.AGENTIO_PASSPHRASE) || cached !== null;
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
    // Fall through to null.
  }
  return null;
}

export async function setPassphrase(passphrase: string): Promise<void> {
  try {
    await getProvider().set(ACCOUNT, passphrase);
  } catch (err) {
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
    // Ignore.
  }
}
