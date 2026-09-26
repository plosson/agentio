import { describe, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { clearVaultCache, loadVault } from '../../src/vault/vault';

/**
 * A vault can outlive a service: telegram was removed from this build, but a
 * vault written before still holds its profiles. They must stay harmless, and
 * the owner must be able to see and remove them.
 */

const PASSPHRASE = 'removed-service-pw-1234';
const vault = withTempVault('agentio-removed-service-test-', () => ({
  passphrase: PASSPHRASE,
  config: {
    profiles: { telegram: [{ name: 'alerts' }, { name: 'bare', readOnly: true }], gdrive: [{ name: 'docs' }] },
    apiKeys: [{
      id: 'k1', name: 'agent', secretHash: 'x', readOnly: false, createdAt: '2026-01-01T00:00:00Z',
      allowedProfiles: ['telegram/alerts', 'gdrive/docs'],
    }],
  },
  credentials: { telegram: { alerts: { botToken: 'bot-secret', channelId: '1' } }, gdrive: { docs: { accessToken: 'at' } } },
}));

async function runCli(args: string[]) {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: vault.home(), AGENTIO_PASSPHRASE: PASSPHRASE, AGENTIO_TOKEN: '' },
  });
  const exitCode = await proc.exited;
  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

async function reload() {
  clearVaultCache();
  return loadVault();
}

describe('a vault that still holds profiles of a removed service', () => {
  test('the service has no commands any more', async () => {
    const res = await runCli(['telegram', 'send', 'hello']);
    // Commander reports any unknown top-level word as excess arguments.
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('too many arguments');
  });

  test('its profiles are listed, alone or with the rest', async () => {
    const all = await runCli(['profile', 'list']);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain('telegram:\n  alerts\n  bare [read-only]');
    expect(all.stdout).toContain('gdrive:');

    const one = await runCli(['profile', 'list', 'telegram']);
    expect(one.exitCode).toBe(0);
    expect(one.stdout).toContain('telegram:');
    expect(one.stdout).not.toContain('gdrive');
  });

  test('status reports them as not installed instead of failing the run', async () => {
    const res = await runCli(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const telegram = JSON.parse(res.stdout).services.telegram;
    expect(telegram.find((p: { profile: string }) => p.profile === 'alerts')).toMatchObject({
      status: 'invalid',
      error: 'plugin is not installed in this agentio build',
    });
  });

  test('no new profile can be added, and none renamed', async () => {
    const added = await runCli(['profile', 'add', 'telegram']);
    expect(added.exitCode).toBe(1);
    expect(added.stderr).toContain('Unknown service: "telegram"');
    expect(added.stderr).not.toContain('telegram,');

    const renamed = await runCli(['profile', 'rename', 'telegram', 'alerts', 'sirens']);
    expect(renamed.exitCode).toBe(1);
    expect(renamed.stderr).toContain('Unknown service: "telegram"');
    expect((await reload()).config.profiles.telegram).toEqual([{ name: 'alerts' }, { name: 'bare', readOnly: true }]);
  });

  test('remove deletes the entry, its credentials and its place in key scopes, and nothing else', async () => {
    const res = await runCli(['profile', 'remove', 'telegram', 'alerts']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Removed profile "alerts"');

    const after = await reload();
    expect(after.config.profiles.telegram).toEqual([{ name: 'bare', readOnly: true }]);
    expect(after.credentials.telegram?.alerts).toBeUndefined();
    expect(after.config.apiKeys![0].allowedProfiles).toEqual(['gdrive/docs']);
    expect(after.config.profiles.gdrive).toEqual([{ name: 'docs' }]);
    expect(after.credentials.gdrive?.docs).toEqual({ accessToken: 'at' });
  });

  test('once its last profile is gone, the service is unknown everywhere', async () => {
    expect((await runCli(['profile', 'remove', 'telegram', 'alerts'])).exitCode).toBe(0);
    expect((await runCli(['profile', 'remove', 'telegram', 'bare'])).exitCode).toBe(0);

    const again = await runCli(['profile', 'remove', 'telegram', 'bare']);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('Unknown service: "telegram"');

    const listed = await runCli(['profile', 'list', 'telegram']);
    expect(listed.exitCode).toBe(1);
    expect(listed.stderr).toContain('Unknown service: "telegram"');
  });

  test('a profile name that does not exist under the removed service is not found, not unknown', async () => {
    const res = await runCli(['profile', 'remove', 'telegram', 'nope']);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('PROFILE_NOT_FOUND');
    expect((await reload()).config.profiles.telegram).toHaveLength(2);
  });

  test('a service that never existed is still unknown', async () => {
    const res = await runCli(['profile', 'remove', 'fax', 'office']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Unknown service: "fax"');
  });
});
