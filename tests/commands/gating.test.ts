import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
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

  test('vault bypasses gate', async () => {
    const res = await runCli(['vault', '--help']);
    expect(res.exitCode).toBe(0);
  });

  test('update bypasses gate', async () => {
    const res = await runCli(['update', '--help']);
    expect(res.exitCode).toBe(0);
  });

  test('plugin verification bypasses the vault gate', async () => {
    const path = join(tempHome, 'plugin.ts');
    await writeFile(path, `export default { apiVersion: 1, id: 'acme', displayName: 'Acme', description: 'Acme plugin', commands: [] };`);
    const res = await runCli(['plugin', 'verify', path]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('acme\tAPI 1\t0 commands\tvalid');
  });

  test('a vault pointer that cannot be read is reported, not a crash or a missing vault', async () => {
    await mkdir(join(tempHome, '.config', 'agentio', 'vault.path'));
    const res = await runCli(['status']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('Error: EISDIR: illegal operation on a directory, read\n');
  });
});

describe('errors under --json', () => {
  test('a gate error is one JSON line on stdout, with nothing on stderr and the usual exit code', async () => {
    const res = await runCli(['status', '--json']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toBe('');
    expect(res.stdout.endsWith('\n')).toBe(true);
    expect(res.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(res.stdout)).toEqual({
      v: 1,
      event: 'error',
      code: 'VAULT_NOT_CONFIGURED',
      message: 'No vault configured',
      suggestion: 'Run: agentio vault init',
    });
  });

  test('without --json the same error stays text on stderr', async () => {
    const res = await runCli(['status']);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('Error [VAULT_NOT_CONFIGURED]: No vault configured\nSuggestion: Run: agentio vault init\n');
  });

  test('an error that is not a CliError has no code and exits 1', async () => {
    await mkdir(join(tempHome, '.config', 'agentio', 'vault.path'));
    const res = await runCli(['status', '--json']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual({
      v: 1,
      event: 'error',
      message: 'EISDIR: illegal operation on a directory, read',
    });
  });

  test("a service's own --json input option does not switch errors to JSON", async () => {
    const res = await runCli(['slack', 'send', '--json']);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Error [VAULT_NOT_CONFIGURED]');
  });

  test('--json on a command that does not offer it is rejected without printing to stdout', async () => {
    const res = await runCli(['gmail', 'list', '--json']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain("unknown option '--json'");
  });
});
