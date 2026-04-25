import { spawnSync } from 'bun';

export interface KeychainProvider {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const SERVICE = 'agentio';
const ACCOUNT = 'vault';

let provider: KeychainProvider | null = null;
let cached: string | null = null;

function macKeychain(): KeychainProvider {
  return {
    async get(account: string) {
      const r = spawnSync({
        cmd: ['security', 'find-generic-password', '-s', SERVICE, '-a', account, '-w'],
        stdout: 'pipe', stderr: 'pipe',
      });
      if (r.exitCode !== 0) return null;
      return r.stdout.toString().replace(/\n$/, '');
    },
    async set(account: string, value: string) {
      const r = spawnSync({
        cmd: ['security', 'add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value],
        stdout: 'pipe', stderr: 'pipe',
      });
      if (r.exitCode !== 0) {
        throw new Error(`security add-generic-password failed: ${r.stderr.toString()}`);
      }
    },
    async delete(account: string) {
      spawnSync({
        cmd: ['security', 'delete-generic-password', '-s', SERVICE, '-a', account],
        stdout: 'pipe', stderr: 'pipe',
      });
    },
  };
}

function hasCmd(cmd: string): boolean {
  const r = spawnSync({ cmd: ['which', cmd], stdout: 'pipe', stderr: 'pipe' });
  return r.exitCode === 0;
}

function secretToolKeychain(): KeychainProvider {
  return {
    async get(account: string) {
      const r = spawnSync({
        cmd: ['secret-tool', 'lookup', 'service', SERVICE, 'account', account],
        stdout: 'pipe', stderr: 'pipe',
      });
      if (r.exitCode !== 0) return null;
      return r.stdout.toString().replace(/\n$/, '');
    },
    async set(account: string, value: string) {
      const proc = Bun.spawn({
        cmd: ['secret-tool', 'store', '--label=agentio', 'service', SERVICE, 'account', account],
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      proc.stdin.write(value);
      proc.stdin.end();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`secret-tool store failed: ${stderr}`);
      }
    },
    async delete(account: string) {
      spawnSync({
        cmd: ['secret-tool', 'clear', 'service', SERVICE, 'account', account],
        stdout: 'pipe', stderr: 'pipe',
      });
    },
  };
}

function noopKeychain(reason: string): KeychainProvider {
  return {
    async get() { return null; },
    async set() {
      throw new Error(`OS keychain is unavailable (${reason}). Use AGENTIO_PASSPHRASE.`);
    },
    async delete() { /* no-op */ },
  };
}

function osKeychain(): KeychainProvider {
  const test = process.env.AGENTIO_KEYCHAIN;
  if (test && test.startsWith('memory:')) {
    return memoryFileKeychain(test.slice('memory:'.length));
  }
  if (process.platform === 'darwin') {
    if (!hasCmd('security')) {
      return noopKeychain('`security` CLI not found on PATH');
    }
    return macKeychain();
  }
  if (process.platform === 'linux') {
    if (!hasCmd('secret-tool')) {
      return noopKeychain('`secret-tool` not installed (apt: libsecret-tools)');
    }
    return secretToolKeychain();
  }
  return noopKeychain(`unsupported platform: ${process.platform}`);
}

function memoryFileKeychain(path: string): KeychainProvider {
  const fs = require('fs');
  function read(): Record<string, string> {
    if (!fs.existsSync(path)) return {};
    try {
      return JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch {
      return {};
    }
  }
  function write(data: Record<string, string>) {
    fs.writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  }
  return {
    async get(account: string) {
      return read()[account] ?? null;
    },
    async set(account: string, value: string) {
      const d = read();
      d[account] = value;
      write(d);
    },
    async delete(account: string) {
      const d = read();
      delete d[account];
      write(d);
    },
  };
}

function getProvider(): KeychainProvider {
  if (provider) return provider;
  provider = osKeychain();
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
