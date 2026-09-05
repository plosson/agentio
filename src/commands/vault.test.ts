import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { encryptVault } from '../vault/crypto';

let tempHome = '';
let passphraseStoreFile = '';

const PASSPHRASE = 'vault-passphrase-12345';
const OTHER_PASSPHRASE = 'other-passphrase-67890';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-vault-test-'));
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

/** Write an encrypted vault file containing `profileCount` telegram profiles. */
async function writeVault(path: string, passphrase: string, profileCount = 0): Promise<void> {
  const contents = {
    version: 1,
    config: {
      profiles: {
        telegram: Array.from({ length: profileCount }, (_, i) => ({ name: `p${i}` })),
      },
    },
    credentials: {},
  };
  await writeFile(path, encryptVault(JSON.stringify(contents), passphrase), { mode: 0o600 });
}

function pointerPath(): string {
  return join(tempHome, '.config', 'agentio', 'vault.path');
}

async function readPointerFile(): Promise<string> {
  return (await readFile(pointerPath(), 'utf-8')).trim();
}

describe('agentio vault set', () => {
  test('adopts a vault when none is configured, using --passphrase', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE, 3);

    const res = await runCli(['vault', 'set', vault, '--passphrase', PASSPHRASE]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`Vault set to ${vault}`);
    expect(res.stdout).toContain('3 profile(s) available');
    expect(await readPointerFile()).toBe(vault);
    const store = JSON.parse(await readFile(passphraseStoreFile, 'utf-8'));
    expect(store.vault).toBe(PASSPHRASE);
  });

  test('reads the passphrase from stdin with --passphrase-stdin', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE, 1);

    const res = await runCli(['vault', 'set', vault, '--passphrase-stdin'], { stdin: PASSPHRASE });

    expect(res.exitCode).toBe(0);
    expect(await readPointerFile()).toBe(vault);
  });

  test('reads the passphrase from AGENTIO_PASSPHRASE', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE);

    const res = await runCli(['vault', 'set', vault], { env: { AGENTIO_PASSPHRASE: PASSPHRASE } });

    expect(res.exitCode).toBe(0);
    expect(await readPointerFile()).toBe(vault);
  });

  test('switches between two existing vaults, leaving both files on disk', async () => {
    const first = join(tempHome, 'first.vault');
    const second = join(tempHome, 'second.vault');
    await writeVault(first, PASSPHRASE, 2);
    await writeVault(second, OTHER_PASSPHRASE, 5);

    await runCli(['vault', 'set', first, '--passphrase', PASSPHRASE]);
    const res = await runCli(['vault', 'set', second, '--passphrase', OTHER_PASSPHRASE]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`Previous: ${first}`);
    expect(res.stdout).toContain('5 profile(s) available');
    expect(await readPointerFile()).toBe(second);
    // Neither vault file is removed by switching.
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    const store = JSON.parse(await readFile(passphraseStoreFile, 'utf-8'));
    expect(store.vault).toBe(OTHER_PASSPHRASE);
  });

  test('rejects a wrong passphrase without changing the pointer', async () => {
    const first = join(tempHome, 'first.vault');
    const second = join(tempHome, 'second.vault');
    await writeVault(first, PASSPHRASE);
    await writeVault(second, OTHER_PASSPHRASE);
    await runCli(['vault', 'set', first, '--passphrase', PASSPHRASE]);

    const res = await runCli(['vault', 'set', second, '--passphrase', 'wrong-passphrase-000']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Could not decrypt');
    // Pointer and stored passphrase still reference the original vault.
    expect(await readPointerFile()).toBe(first);
    const store = JSON.parse(await readFile(passphraseStoreFile, 'utf-8'));
    expect(store.vault).toBe(PASSPHRASE);
  });

  test('errors when the vault file does not exist', async () => {
    const res = await runCli([
      'vault', 'set', join(tempHome, 'missing.vault'), '--passphrase', PASSPHRASE,
    ]);

    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain('No vault file at');
    expect(existsSync(pointerPath())).toBe(false);
  });

  test('rejects --passphrase together with --passphrase-stdin', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE);

    const res = await runCli(
      ['vault', 'set', vault, '--passphrase', PASSPHRASE, '--passphrase-stdin'],
      { stdin: PASSPHRASE }
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('mutually exclusive');
  });

  test('errors instead of hanging when no passphrase is available off a TTY', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE);

    const res = await runCli(['vault', 'set', vault], { stdin: '' });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('no terminal is available');
  });

  test('reports an unchanged vault when set to the already-active path', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE, 4);
    await runCli(['vault', 'set', vault, '--passphrase', PASSPHRASE]);

    const res = await runCli(['vault', 'set', vault, '--passphrase', PASSPHRASE]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Vault unchanged');
    expect(await readPointerFile()).toBe(vault);
  });

  test('resolves a directory argument to the default vault filename', async () => {
    const dir = join(tempHome, 'vaults');
    await mkdir(dir, { recursive: true });
    const vault = join(dir, 'agentio.vault');
    await writeVault(vault, PASSPHRASE, 1);

    const res = await runCli(['vault', 'set', dir, '--passphrase', PASSPHRASE]);

    expect(res.exitCode).toBe(0);
    expect(await readPointerFile()).toBe(vault);
  });

  test('runs before any vault is configured (bypasses the vault guard)', async () => {
    const vault = join(tempHome, 'work.vault');
    await writeVault(vault, PASSPHRASE);

    const res = await runCli(['vault', 'set', vault, '--passphrase', PASSPHRASE]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain('VAULT_NOT_CONFIGURED');
  });
});
