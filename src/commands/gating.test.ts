import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tempHome = '';
let passphraseStoreFile = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-gating-test-'));
  passphraseStoreFile = join(tempHome, 'passphrase-store.json');
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: tempHome,
      AGENTIO_PASSPHRASE_STORE: `memory:${passphraseStoreFile}`,
    },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

describe('command gating', () => {
  test('service command fails with VAULT_NOT_CONFIGURED when no vault', async () => {
    const res = await runCli(['gmail', 'list']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('VAULT_NOT_CONFIGURED');
  });

  test('--help bypasses gate', async () => {
    const res = await runCli(['--help']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Usage');
  });

  test('--version bypasses gate', async () => {
    const res = await runCli(['--version']);
    expect(res.exitCode).toBe(0);
  });

  test('docs bypasses gate', async () => {
    const res = await runCli(['docs']);
    expect(res.exitCode).toBe(0);
  });

  test('setup bypasses gate', async () => {
    const res = await runCli(['setup', '--help']);
    expect(res.exitCode).toBe(0);
  });

  test('update bypasses gate', async () => {
    const res = await runCli(['update', '--help']);
    expect(res.exitCode).toBe(0);
  });
});
