import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedVault } from '../vault/test-helpers';
import { clearVaultCache } from '../vault/vault';
import { decodeToken } from '../auth/token';

/** Subprocess tests for `agentio key`, the CLI twin of the UI's Keys card. */

const PASSPHRASE = 'key-test-pw-1234';
let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-key-test-'));
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
  process.env.HOME = tempHome;
  await seedVault({ passphrase: PASSPHRASE, config: { profiles: { gdrive: [{ name: 'docs' }] } } });
});

afterEach(async () => {
  process.env.HOME = savedHome;
  delete process.env.AGENTIO_PASSPHRASE;
  clearVaultCache();
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: tempHome, AGENTIO_PASSPHRASE: PASSPHRASE },
  });
  const exitCode = await proc.exited;
  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe('agentio key', () => {
  test('create prints the token alone on stdout; list, rotate, revoke follow', async () => {
    const created = await runCli(['key', 'create', 'ci', '--url', 'https://vault.example.com', '--profiles', 'gdrive/docs', '--read-only']);
    expect(created.exitCode).toBe(0);
    const token = created.stdout.trim();
    expect(token.split('\n')).toHaveLength(1);
    const { kid, url } = decodeToken(token);
    expect(url).toBe('https://vault.example.com');
    expect(created.stderr).toContain('shown once');

    const listed = await runCli(['key', 'list']);
    expect(listed.stdout).toContain(`${kid}  ci  gdrive/docs, read-only`);

    const rotated = await runCli(['key', 'rotate', kid, '--url', 'https://vault.example.com']);
    expect(rotated.exitCode).toBe(0);
    const rotatedToken = rotated.stdout.trim();
    expect(decodeToken(rotatedToken).kid).toBe(kid);
    expect(rotatedToken).not.toBe(token);

    const revoked = await runCli(['key', 'revoke', kid]);
    expect(revoked.exitCode).toBe(0);
    expect((await runCli(['key', 'list'])).stdout).toContain('No API keys');
  });

  test('create refuses a missing scope and --all with --profiles', async () => {
    const missing = await runCli(['key', 'create', 'x', '--url', 'https://h']);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('Choose a scope');
    const both = await runCli(['key', 'create', 'x', '--url', 'https://h', '--all', '--profiles', 'gdrive/docs']);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain('mutually exclusive');
  });
});
