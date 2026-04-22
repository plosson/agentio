import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
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
