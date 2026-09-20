import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir, hostname, userInfo } from 'os';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createCipheriv, scryptSync, randomBytes } from 'crypto';

let tempHome = '';
let passphraseStoreFile = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-vault-init-test-'));
  passphraseStoreFile = join(tempHome, 'passphrase-store.json');
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
    stdin: opts.stdin !== undefined ? 'pipe' : 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_PASSPHRASE_STORE: `memory:${passphraseStoreFile}`,
      ...(opts.env ?? {}),
    },
  });
  if (opts.stdin !== undefined) {
    proc.stdin!.write(opts.stdin);
    proc.stdin!.end();
  }
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function pointerFile(): string {
  return join(tempHome, '.config', 'agentio', 'vault.path');
}

async function readPointerFile(): Promise<string> {
  return (await readFile(pointerFile(), 'utf-8')).trim();
}

async function readStore(): Promise<Record<string, string>> {
  if (!existsSync(passphraseStoreFile)) return {};
  return JSON.parse((await readFile(passphraseStoreFile, 'utf-8')) || '{}');
}

/** Create a vault at the default location and return its path. */
async function initVault(passphrase: string): Promise<string> {
  const vaultPath = join(tempHome, '.config', 'agentio', 'vault.enc');
  await runCli(['vault', 'init', '--path', vaultPath, '--passphrase', passphrase]);
  return vaultPath;
}

describe('agentio vault init — first-time path', () => {
  test('creates vault, pointer, and passphrase store entry', async () => {
    const vaultPath = join(tempHome, '.config', 'agentio', 'vault.enc');
    const res = await runCli(['vault', 'init', '--path', vaultPath, '--passphrase', 'test-passphrase-12345']);

    expect(res.exitCode).toBe(0);
    expect(existsSync(vaultPath)).toBe(true);
    expect(await readPointerFile()).toBe(vaultPath);
    expect((await readStore()).vault).toBe('test-passphrase-12345');
  });

  test('accepts the passphrase on stdin', async () => {
    const vaultPath = join(tempHome, '.config', 'agentio', 'vault.enc');
    const res = await runCli(['vault', 'init', '--path', vaultPath, '--passphrase-stdin'], {
      stdin: 'piped-passphrase-123',
    });

    expect(res.exitCode).toBe(0);
    expect((await readStore()).vault).toBe('piped-passphrase-123');
  });

  test('refuses to run if passphrase shorter than 8 chars', async () => {
    const res = await runCli([
      'vault', 'init', '--path', join(tempHome, '.config', 'agentio', 'vault.enc'), '--passphrase', 'short',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain('passphrase');
  });

  test('refuses non-absolute vault path', async () => {
    const res = await runCli([
      'vault', 'init', '--path', 'relative/vault.enc', '--passphrase', 'test-passphrase-12345',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('absolute');
  });

  test('refuses to overwrite an already-configured vault', async () => {
    await initVault('first-pw-12345');

    const res = await runCli([
      'vault', 'init', '--path', join(tempHome, 'second.enc'), '--passphrase', 'second-pw-12345',
    ]);

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('already configured');
  });

  test('errors instead of hanging when no passphrase source is available off a TTY', async () => {
    const res = await runCli(
      ['vault', 'init', '--path', join(tempHome, '.config', 'agentio', 'vault.enc')],
      { stdin: '' }
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('no terminal is available');
  });
});

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
  writeFileSync(
    path,
    JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') }),
    { mode: 0o600 }
  );
}

describe('agentio vault init — migration path', () => {
  test('migrates legacy config.json and tokens.enc into the vault by default', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    const legacyTokensPath = join(cfgDir, 'tokens.enc');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });
    writeLegacyTokensEnc(legacyTokensPath, { gmail: { work: { token: 'xyz' } } });

    const vaultPath = join(cfgDir, 'vault.enc');
    const res = await runCli(['vault', 'init', '--path', vaultPath, '--passphrase', 'migration-pw-123']);

    expect(res.exitCode).toBe(0);
    expect(existsSync(vaultPath)).toBe(true);
    expect(existsSync(legacyConfigPath)).toBe(false);
    expect(existsSync(legacyConfigPath + '.bak')).toBe(true);
    expect(existsSync(legacyTokensPath + '.bak')).toBe(true);

    const statusRes = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'migration-pw-123' },
    });
    expect(statusRes.exitCode).toBe(0);
    expect(statusRes.stdout).toContain('work');
  });

  test('migration with undecryptable tokens.enc still imports config', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    await writeFile(join(cfgDir, 'config.json'), JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
    const enc = Buffer.concat([cipher.update('{}', 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    await writeFile(
      join(cfgDir, 'tokens.enc'),
      JSON.stringify({ iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') }),
      { mode: 0o600 }
    );

    const res = await runCli([
      'vault', 'init', '--path', join(cfgDir, 'vault.enc'), '--passphrase', 'migration-pw-123',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('credentials could not be recovered');
  });

  test('--no-migrate starts fresh and leaves legacy files untouched', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });

    const res = await runCli([
      'vault', 'init', '--path', join(cfgDir, 'vault.enc'), '--passphrase', 'migration-pw-123', '--no-migrate',
    ]);

    expect(res.exitCode).toBe(0);
    expect(existsSync(legacyConfigPath)).toBe(true);
    expect(existsSync(legacyConfigPath + '.bak')).toBe(false);
  });
});

describe('agentio vault passphrase', () => {
  test('re-encrypts the vault and updates the passphrase store', async () => {
    await initVault('old-pw-12345');

    const res = await runCli(['vault', 'passphrase', '--passphrase', 'new-pw-67890']);
    expect(res.exitCode).toBe(0);
    expect((await readStore()).vault).toBe('new-pw-67890');

    const resOld = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'old-pw-12345' },
    });
    expect(resOld.exitCode).not.toBe(0);

    const resNew = await runCli(['status', '--no-test', '--json'], {
      env: { AGENTIO_PASSPHRASE: 'new-pw-67890' },
    });
    expect(resNew.exitCode).toBe(0);
  });

  test('rejects a new passphrase shorter than 8 chars', async () => {
    await initVault('old-pw-12345');
    const res = await runCli(['vault', 'passphrase', '--passphrase', 'tiny']);
    expect(res.exitCode).not.toBe(0);
  });
});

describe('agentio vault reset', () => {
  test('wipes vault, pointer, and passphrase store entry', async () => {
    const vaultPath = await initVault('pw-12345');

    const res = await runCli(['vault', 'reset', '--force']);
    expect(res.exitCode).toBe(0);
    expect(existsSync(vaultPath)).toBe(false);
    expect(existsSync(pointerFile())).toBe(false);
    expect((await readStore()).vault).toBeUndefined();
  });

  test('refuses to reset without --force when there is no terminal to confirm', async () => {
    const vaultPath = await initVault('pw-12345');

    const res = await runCli(['vault', 'reset'], { stdin: '' });
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(vaultPath)).toBe(true);
  });
});

describe('agentio vault status', () => {
  test('reports the active vault path and profile count', async () => {
    const vaultPath = await initVault('pw-12345');

    const res = await runCli(['vault', 'status']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(vaultPath);
    expect(res.stdout).toContain('Profiles: 0');
  });

  test('errors when no vault is configured', async () => {
    const res = await runCli(['vault', 'status']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('No vault configured');
  });
});

describe('agentio vault init — directory path normalization', () => {
  test('appends the default filename when path is an existing directory', async () => {
    const dir = join(tempHome, 'my-vault-dir');
    await mkdir(dir, { recursive: true });

    const res = await runCli(['vault', 'init', '--path', dir, '--passphrase', 'test-pw-12345']);
    expect(res.exitCode).toBe(0);

    const expected = join(dir, 'agentio.vault');
    expect(existsSync(expected)).toBe(true);
    expect(await readPointerFile()).toBe(expected);
    expect(res.stdout).toContain('Path is a directory');
  });

  test('trailing slash is treated as a directory intent', async () => {
    const dir = join(tempHome, 'new-dir') + '/';
    const res = await runCli(['vault', 'init', '--path', dir, '--passphrase', 'test-pw-12345']);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(tempHome, 'new-dir', 'agentio.vault'))).toBe(true);
  });
});

describe('agentio vault init — rollback on failure', () => {
  test('legacy files and passphrase store untouched if the vault write fails', async () => {
    const cfgDir = join(tempHome, '.config', 'agentio');
    const legacyConfigPath = join(cfgDir, 'config.json');
    const legacyTokensPath = join(cfgDir, 'tokens.enc');
    await writeFile(legacyConfigPath, JSON.stringify({ profiles: { gmail: [{ name: 'work' }] } }), { mode: 0o600 });
    await writeFile(legacyTokensPath, '{}', { mode: 0o600 });

    // Parent is a file, so mkdir cannot create it and the vault write fails.
    const res = await runCli([
      'vault', 'init', '--path', '/dev/null/vault.enc', '--passphrase', 'migration-pw-123',
    ]);
    expect(res.exitCode).not.toBe(0);

    expect(existsSync(legacyConfigPath)).toBe(true);
    expect(existsSync(legacyConfigPath + '.bak')).toBe(false);
    expect(existsSync(legacyTokensPath)).toBe(true);
    expect(existsSync(legacyTokensPath + '.bak')).toBe(false);
    expect(existsSync(pointerFile())).toBe(false);
    expect((await readStore()).vault).toBeUndefined();
  });

  test('first-time init also cleans up the pointer on vault write failure', async () => {
    const res = await runCli([
      'vault', 'init', '--path', '/dev/null/vault.enc', '--passphrase', 'test-pw-12345',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(existsSync(pointerFile())).toBe(false);
  });
});
