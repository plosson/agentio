import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

let tempHome = '';
let passphraseStoreFile = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-e2e-'));
  passphraseStoreFile = join(tempHome, 'passphrase-store.json');
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  delete process.env.AGENTIO_PASSPHRASE;
  delete process.env.AGENTIO_PASSPHRASE_STORE;
});

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_PASSPHRASE_STORE: `memory:${passphraseStoreFile}`,
      ...extraEnv,
    },
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe('e2e: first-install → vault init → status → reset', () => {
  test('full happy path', async () => {
    // Gate blocks
    const r1 = await runCli(['status', '--no-test']);
    expect(r1.exitCode).not.toBe(0);
    expect(r1.stderr).toContain('VAULT_NOT_CONFIGURED');

    // Init
    const r2 = await runCli([
      'vault', 'init',
      '--path', join(tempHome, '.config', 'agentio', 'vault.enc'),
      '--passphrase', 'e2e-passphrase-12345',
    ]);
    expect(r2.exitCode).toBe(0);

    // Status now works — store-resolved passphrase
    const r3 = await runCli(['status', '--no-test']);
    expect(r3.exitCode).toBe(0);

    // Reset
    const r4 = await runCli(['vault', 'reset', '--force']);
    expect(r4.exitCode).toBe(0);

    // Gate blocks again
    const r5 = await runCli(['status', '--no-test']);
    expect(r5.exitCode).not.toBe(0);
    expect(r5.stderr).toContain('VAULT_NOT_CONFIGURED');
  });
});

describe('e2e: daemon fails fast with VAULT_LOCKED when no passphrase source', () => {
  test('non-bypass command without store or env fails cleanly', async () => {
    // Create vault with passphrase written to passphrase store
    await runCli([
      'vault', 'init',
      '--path', join(tempHome, '.config', 'agentio', 'vault.enc'),
      '--passphrase', 'daemon-pw-12345',
    ]);

    // Run a non-bypass command (gmail list) with an EMPTY store file —
    // simulates a subprocess with no cached passphrase (e.g. headless daemon).
    const emptyStore = join(tempHome, 'empty-store.json');
    await Bun.write(emptyStore, '{}');
    const res = await runCli(['gmail', 'list'], {
      AGENTIO_PASSPHRASE_STORE: `memory:${emptyStore}`,
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('VAULT_LOCKED');

    // Now set AGENTIO_PASSPHRASE — same command should pass the gate and
    // reach actual command logic (which will then hit a downstream error,
    // e.g. PROFILE_NOT_FOUND — that is fine, we only assert NOT VAULT_LOCKED).
    const res2 = await runCli(['gmail', 'list'], {
      AGENTIO_PASSPHRASE_STORE: `memory:${emptyStore}`,
      AGENTIO_PASSPHRASE: 'daemon-pw-12345',
    });
    // exit code may be non-zero but it MUST NOT be VAULT_LOCKED
    expect(res2.stderr).not.toContain('VAULT_LOCKED');
  });
});
