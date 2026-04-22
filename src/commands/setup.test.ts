import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir } from 'fs/promises';
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
