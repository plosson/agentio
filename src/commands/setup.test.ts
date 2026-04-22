import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { encryptVault } from '../vault/crypto';

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

    // Now that config-manager reads from the vault, verify `agentio status`
    // with the migration passphrase returns exit 0 and includes the
    // imported gmail:work profile.
    const statusRes = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'migration-pw-123' },
    });
    expect(statusRes.exitCode).toBe(0);
    const parsed = JSON.parse(statusRes.stdout);
    const gmail = parsed.gmail ?? parsed.profiles?.gmail;
    // Accept any shape that includes the 'work' profile name.
    const serialized = JSON.stringify(gmail ?? parsed);
    expect(serialized).toContain('work');
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

describe('agentio setup — adopt existing vault', () => {
  test('prompts for passphrase of an existing vault file and writes pointer + keychain', async () => {
    const vaultPath = join(tempHome, 'dropbox', 'myvault.enc');
    await mkdir(dirname(vaultPath), { recursive: true });
    const payload = JSON.stringify({
      version: 1,
      config: { profiles: { gmail: [{ name: 'imported' }] } },
      credentials: {},
    });
    await writeFile(vaultPath, encryptVault(payload, 'adopt-pw-12345'));

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_ADOPT: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'adopt-pw-12345',
      },
    });
    expect(res.exitCode).toBe(0);

    const kc = JSON.parse(await readFile(keychainFile, 'utf-8'));
    expect(kc.vault).toBe('adopt-pw-12345');
    const pointer = (await readFile(join(tempHome, '.config', 'agentio', 'vault.path'), 'utf-8')).trim();
    expect(pointer).toBe(vaultPath);
  });

  test('rejects wrong passphrase when adopting', async () => {
    const vaultPath = join(tempHome, 'myvault.enc');
    await writeFile(
      vaultPath,
      encryptVault(JSON.stringify({ version: 1, config: { profiles: {} }, credentials: {} }), 'right-pw')
    );
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_ADOPT: '1',
        AGENTIO_SETUP_VAULT_PATH: vaultPath,
        AGENTIO_SETUP_PASSPHRASE: 'wrong-pw',
      },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('passphrase');
  });
});

async function preSetupVault(passphrase: string): Promise<string> {
  const vaultPath = join(tempHome, '.config', 'agentio', 'vault.enc');
  await runCli(['setup'], {
    env: {
      AGENTIO_SETUP_NONINTERACTIVE: '1',
      AGENTIO_SETUP_VAULT_PATH: vaultPath,
      AGENTIO_SETUP_PASSPHRASE: passphrase,
    },
  });
  return vaultPath;
}

describe('agentio setup — existing vault menu', () => {
  test('change passphrase re-encrypts vault and updates keychain', async () => {
    await preSetupVault('old-pw-12345');

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_MENU: 'change-passphrase',
        AGENTIO_SETUP_PASSPHRASE: 'new-pw-67890',
      },
    });
    expect(res.exitCode).toBe(0);

    const kc = JSON.parse(await readFile(keychainFile, 'utf-8'));
    expect(kc.vault).toBe('new-pw-67890');

    // Now that config-manager reads from the vault, verify that running
    // `agentio status` with the OLD passphrase fails (AUTH_FAILED) and
    // with the NEW passphrase succeeds.
    const resOld = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'old-pw-12345' },
    });
    expect(resOld.exitCode).not.toBe(0);

    const resNew = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'new-pw-67890' },
    });
    expect(resNew.exitCode).toBe(0);
  });

  test('move vault copies file to new location and updates pointer', async () => {
    const originalPath = await preSetupVault('pw-12345');
    const newPath = join(tempHome, 'relocated.enc');

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_MENU: 'move-vault',
        AGENTIO_SETUP_VAULT_PATH: newPath,
      },
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(originalPath)).toBe(false);
    const pointer = (await readFile(join(tempHome, '.config', 'agentio', 'vault.path'), 'utf-8')).trim();
    expect(pointer).toBe(newPath);
  });
});

describe('agentio setup --reset', () => {
  test('wipes vault, pointer, and keychain entry', async () => {
    const vaultPath = await preSetupVault('pw-12345');

    const res = await runCli(['setup', '--reset', '--force']);
    expect(res.exitCode).toBe(0);
    expect(existsSync(vaultPath)).toBe(false);
    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.path'))).toBe(false);
    const kcRaw = existsSync(keychainFile) ? await readFile(keychainFile, 'utf-8') : '{}';
    const kc = JSON.parse(kcRaw || '{}');
    expect(kc.vault).toBeUndefined();
  });
});

describe('agentio setup — directory path normalization', () => {
  test('first-time setup appends default filename when path is an existing directory', async () => {
    const dir = join(tempHome, 'my-vault-dir');
    await mkdir(dir, { recursive: true });

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: dir,
        AGENTIO_SETUP_PASSPHRASE: 'test-pw-12345',
      },
    });
    expect(res.exitCode).toBe(0);
    const expected = join(dir, 'agentio.vault');
    expect(existsSync(expected)).toBe(true);
    const pointer = (await readFile(join(tempHome, '.config', 'agentio', 'vault.path'), 'utf-8')).trim();
    expect(pointer).toBe(expected);
    expect(res.stdout).toContain('Path is a directory');
  });

  test('trailing slash is treated as a directory intent', async () => {
    const dir = join(tempHome, 'new-dir') + '/';
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: dir,
        AGENTIO_SETUP_PASSPHRASE: 'test-pw-12345',
      },
    });
    expect(res.exitCode).toBe(0);
    const expected = join(tempHome, 'new-dir', 'agentio.vault');
    expect(existsSync(expected)).toBe(true);
  });
});

describe('agentio setup — migration rollback on failure', () => {
  test('legacy files and keychain are untouched if vault write fails', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    const legacyTokensPath = join(cfgDir, 'tokens.enc');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });
    // tokens.enc with a garbage body — still counts as "hasTokens" for detectLegacy
    await writeFile(legacyTokensPath, '{}', { mode: 0o600 });

    // Point the vault at an unwritable path: a file path whose parent is itself a FILE,
    // so mkdir can't create the parent and writeFile will fail. We use /dev/null as the parent.
    const unwritableVault = '/dev/null/vault.enc';

    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: unwritableVault,
        AGENTIO_SETUP_PASSPHRASE: 'migration-pw-123',
        AGENTIO_SETUP_MIGRATE: 'yes',
      },
    });
    expect(res.exitCode).not.toBe(0);

    // Legacy files must still be at their original names (not .bak)
    expect(existsSync(legacyConfigPath)).toBe(true);
    expect(existsSync(legacyConfigPath + '.bak')).toBe(false);
    expect(existsSync(legacyTokensPath)).toBe(true);
    expect(existsSync(legacyTokensPath + '.bak')).toBe(false);

    // Pointer must be cleaned up so the next setup run starts fresh
    expect(existsSync(join(cfgDir, 'vault.path'))).toBe(false);

    // Keychain must not have been written (setPassphrase runs after saveVault)
    const kcRaw = existsSync(keychainFile) ? await readFile(keychainFile, 'utf-8') : '{}';
    const kc = JSON.parse(kcRaw || '{}');
    expect(kc.vault).toBeUndefined();
  });

  test('first-time setup also cleans up pointer on vault write failure', async () => {
    const unwritableVault = '/dev/null/vault.enc';
    const res = await runCli(['setup'], {
      env: {
        AGENTIO_SETUP_NONINTERACTIVE: '1',
        AGENTIO_SETUP_VAULT_PATH: unwritableVault,
        AGENTIO_SETUP_PASSPHRASE: 'test-pw-12345',
      },
    });
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.path'))).toBe(false);
  });
});
