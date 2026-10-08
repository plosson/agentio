import { afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname } from 'path';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import { clearVaultCache, loadVault } from '../../../src/vault/vault';
import type { KiteCredentials } from '../../../src/plugins/kite/types';
import { FakeKite } from './fake-kite';

const EMAIL = 'pa@example.com';
const vault = withTempVault('agentio-kite-add-', () => ({ config: { profiles: {} } as never }));
let fake: FakeKite;
beforeEach(() => { fake = new FakeKite(); });
afterEach(() => fake.stop());

// Only bun on PATH: no browser opener can be found, so nothing opens.
const cli = (args: string[]) => runCli(['kite', 'profile', 'add', ...args], { ...vault.env(), PATH: dirname(process.execPath) });

test('--json: only the code event on stdout, then the profile is saved read-only; no secret is printed', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const res = await cli(['--json', '--url', fake.url, '--read-only']);
  expect(res.exitCode).toBe(0);
  const device = [...fake.devices.values()][0];
  expect(res.events).toEqual([
    { v: 1, event: 'code', userCode: device.userCode, verificationUrl: `${fake.url}/auth/device?code=${device.userCode}`, expiresIn: 600 },
  ]);
  clearVaultCache();
  const saved = await getCredentials<KiteCredentials>('kite', EMAIL);
  expect(saved?.baseUrl).toBe(fake.url);
  for (const secret of [saved!.token, device.deviceCode]) {
    expect(res.stdout).not.toContain(secret);
    expect(res.stderr).not.toContain(secret);
  }
  expect((await loadVault()).config.profiles.kite).toEqual([{ name: EMAIL, readOnly: true }]);
}, 30_000);

test('the program-facing setup options are gone: --describe and --input are unknown, nothing is contacted', async () => {
  for (const args of [['--describe', '--json'], ['--json', '--input', '-']]) {
    const res = await cli(args);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain(`unknown option '${args.find((a) => a !== '--json')}'`);
  }
  expect(fake.requests()).toEqual([]);
}, 30_000);

test('a sign-in refused in the browser saves nothing and says so', async () => {
  fake.nextDeviceApproval = undefined;
  const run = cli(['--url', fake.url]);
  // Deny as soon as the code exists.
  for (let i = 0; i < 200 && fake.devices.size === 0; i++) await Bun.sleep(25);
  fake.deny([...fake.devices.values()][0].userCode);
  const res = await run;
  expect(res.exitCode).toBe(2);
  expect(res.stderr).toContain('To sign in to Kite, open:');
  expect(res.stderr).toContain('Error [AUTH_FAILED]');
  expect(res.stdout).not.toContain('configured');
  clearVaultCache();
  expect((await loadVault()).config.profiles.kite ?? []).toEqual([]);
}, 30_000);
