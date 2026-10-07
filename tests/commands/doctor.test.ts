import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkCli, cliChecks, renderChecks, type Check } from '../../src/commands/doctor';
import { CLAUDE_CLI } from '../../src/utils/external-cli';
import { encodeToken } from '../../src/auth/token';
import { resetRemoteCache } from '../../src/auth/remote';
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
    delete process.env.AGENTIO_TOKEN;
    resetRemoteCache();
    await fake.restore();
  });

  test('an unreachable hub yields no checks and does not throw', async () => {
    // Port 1 refuses connections: remoteProfiles() throws, which must not lose the doctor report.
    process.env.AGENTIO_TOKEN = encodeToken({ url: 'http://127.0.0.1:1', kid: 'kid', secret: 'secret' });
    resetRemoteCache();
    expect(await cliChecks()).toEqual([]);
  });
});
