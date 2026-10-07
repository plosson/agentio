import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkCli, cliChecks, renderChecks, type Check } from '../../src/commands/doctor';
import { CLAUDE_CLI } from '../../src/utils/external-cli';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli } from '../helpers/cli';
import { installFakeCli, type FakeCli } from '../helpers/fake-cli';

describe('renderChecks', () => {
  test('formats ok/warn/error with leading symbols', () => {
    const checks: Check[] = [
      { name: 'Vault', status: 'ok', detail: 'configured at ~/.config/agentio/vault.enc' },
      { name: 'Daemon', status: 'warn', detail: 'not running' },
      { name: 'Profiles', status: 'error', detail: 'no profiles configured', fix: 'agentio gmail profile add' },
    ];
    const out = renderChecks(checks);
    expect(out).toContain('✓ Vault');
    expect(out).toContain('! Daemon');
    expect(out).toContain('✗ Profiles');
    expect(out).toContain('agentio gmail profile add');
  });
});

describe('checkCli', () => {
  let fake: FakeCli;
  beforeEach(async () => {
    fake = await installFakeCli('claude');
    fake.respond({ stdout: '2.3.0 (Claude Code)\n' });
  });
  afterEach(async () => {
    await fake.restore();
  });

  test('nothing without a profile of the service', async () => {
    expect(await checkCli(CLAUDE_CLI, 'claude', new Set(['gmail']))).toBeNull();
  });

  test('found: its version', async () => {
    expect(await checkCli(CLAUDE_CLI, 'claude', new Set(['claude']))).toEqual({ name: 'claude CLI', status: 'ok', detail: 'found, 2.3.0 (Claude Code)' });
  });

  test('missing: a warning with the install command', async () => {
    process.env.PATH = '/nonexistent';
    const check = await checkCli(CLAUDE_CLI, 'claude', new Set(['claude']));
    expect(check).toMatchObject({ name: 'claude CLI', status: 'warn', detail: 'not installed', fix: 'curl -fsSL https://claude.ai/install.sh | bash' });
  });
});

describe('cliChecks', () => {
  let fake: FakeCli;
  beforeEach(async () => {
    fake = await installFakeCli('claude');
    fake.respond({ stdout: '2.3.0\n' });
  });
  afterEach(async () => {
    await fake.restore();
  });

  test('no profiles yield no checks', async () => {
    expect(await cliChecks([])).toEqual([]);
  });

  test('only the services with a profile are checked', async () => {
    const checks = await cliChecks([{ service: 'claude', name: 'work' }]);
    expect(checks.map((c) => c.name)).toEqual(['claude CLI']);
  });
});

describe('doctor when profiles cannot be listed (local mode)', () => {
  test('still prints the report instead of a bare error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentio-doctor-home-'));
    try {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
      for (const name of ['AGENTIO_TOKEN', 'AGENTIO_PASSPHRASE', 'AGENTIO_HOME']) delete env[name];
      const res = await runCli(['doctor'], env);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain('✗ Vault');
      expect(res.stdout).toContain('✗ Profiles');
      expect(res.stdout).not.toContain('CLI');
      expect(res.stderr).not.toContain('Error [');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
