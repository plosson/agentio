import { expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { setProfileReadOnly } from '../../../src/config/config-manager';
import { withTempVault } from '../../helpers/vault';

const TOKEN = 'picsi-cli-test-secret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const vault = withTempVault('agentio-picsi-cli-', () => ({
  config: { profiles: { picsi: [{ name: 'personal' }] } },
  credentials: { picsi: { personal: { token: TOKEN } } },
}));

async function cli(args: string[]) {
  const proc = Bun.spawn(['bun', '--preload', resolve('tests/plugins/picsi/stub-api-preload.ts'), './src/index.ts', ...args], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...vault.env(), PICSI_TEST_LOG: join(vault.home(), 'requests.log'), NO_COLOR: '1' },
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  expect(stdout + stderr).not.toContain(TOKEN);
  return { code, stdout, stderr };
}

function swapArgs(): string[] {
  return ['picsi', 'swap', '--source', join(vault.home(), 'face.png'), '--target', join(vault.home(), 'face.png'), '-o', join(vault.home(), 'result.png')];
}

test('the real command resolves its profile, uploads once, saves the image and prints structured results', async () => {
  await writeFile(join(vault.home(), 'face.png'), PNG);
  const account = await cli(['picsi', 'account', '--json']);
  expect(account.code).toBe(0);
  expect(JSON.parse(account.stdout)).toMatchObject({ name: 'Pat', plan: 'Pro', creditsRemaining: 398 });
  const result = await cli([...swapArgs(), '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ saved: join(vault.home(), 'result.png'), creditsRemaining: 398, creditsTotal: 400 });
  expect(await readFile(join(vault.home(), 'result.png'))).toEqual(PNG);
  expect(await readFile(join(vault.home(), 'requests.log'), 'utf8')).toBe('/user/info\n/api/morph/token\n/api/morph/image\n');
});

test('read-only profiles refuse a swap before requesting a slot or uploading', async () => {
  await setProfileReadOnly('picsi', 'personal', true);
  const result = await cli([...swapArgs(), '--json']);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(existsSync(join(vault.home(), 'requests.log'))).toBe(false);
});

test('an occupied output or bad coordinate is refused before any service request', async () => {
  await writeFile(join(vault.home(), 'result.png'), PNG);
  expect((await cli(swapArgs())).code).toBe(1);
  expect((await cli([...swapArgs(), '--at', '101,50'])).code).toBe(1);
  expect(existsSync(join(vault.home(), 'requests.log'))).toBe(false);
  expect(await readFile(join(vault.home(), 'result.png'))).toEqual(PNG);
});

test('profile import persists the Picsi session through the normal host setup and can be used by name', async () => {
  const added = await cli(['picsi', 'profile', 'add', '--profile', 'imported', '--token', TOKEN]);
  expect(added.code).toBe(0);
  const account = await cli(['picsi', 'account', '--profile', 'imported', '--json']);
  expect(account.code).toBe(0);
  expect(JSON.parse(account.stdout)).toMatchObject({ name: 'Pat' });
});
