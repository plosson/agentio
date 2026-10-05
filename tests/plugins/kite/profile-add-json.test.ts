import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { FakeKite } from './fake-kite';

const EMAIL = 'pa@example.com';
const vault = withTempVault('agentio-kite-json-', () => ({ config: { profiles: {} } as never }));
let fake: FakeKite;
beforeEach(() => { fake = new FakeKite(); });
afterEach(() => fake.stop());

/** Run the CLI with `lines` on stdin, then close it; it must exit by itself within 30 s. */
async function cli(args: string[], lines: string[] = []) {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: vault.env() });
  for (const line of lines) proc.stdin.write(`${line}\n`);
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), 30_000);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stdout, events: stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), stderr: await new Response(proc.stderr).text() };
}

test('--describe --json: a server URL, then a device-code sign-in; nothing is contacted', async () => {
  const res = await cli(['kite', 'profile', 'add', '--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'kite', auth: 'device-code',
    inputs: [{ id: 'url', label: 'Kite server URL', kind: 'url', help: 'For example https://kite.example.com' }],
  }]);
  expect(fake.requests()).toEqual([]);
});

test('--describe without --json is refused', async () => {
  const res = await cli(['kite', 'profile', 'add', '--describe']);
  expect(res.exitCode).not.toBe(0);
  expect(res.stderr).toContain('--describe needs --json');
});

test('--json --input -: the code, the address to open, then added; the token is never printed', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const res = await cli(['kite', 'profile', 'add', '--json', '--input', '-', '--read-only'], [JSON.stringify({ url: fake.url })]);
  expect(res.exitCode).toBe(0);
  const device = [...fake.devices.values()][0];
  const page = `${fake.url}/auth/device?code=${device.userCode}`;
  expect(res.events).toEqual([
    { v: 1, event: 'code', userCode: device.userCode, verificationUrl: page, expiresIn: 600 },
    { v: 1, event: 'open', url: page },
    { v: 1, event: 'added', service: 'kite', profile: EMAIL, readOnly: true },
  ]);
  for (const d of fake.devices.values()) expect(res.stdout).not.toContain(d.deviceCode);
});

test('--json without --input asks the URL first', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const res = await cli(['kite', 'profile', 'add', '--json'], [JSON.stringify({ id: 'url', value: fake.url })]);
  expect(res.exitCode).toBe(0);
  expect(res.events.map((e) => e.event)).toEqual(['ask', 'code', 'open', 'added']);
  expect(res.events[0]).toEqual({ v: 1, event: 'ask', id: 'url', label: 'Kite server URL', kind: 'url', help: 'For example https://kite.example.com' });
});

test('--json --no-browser: the code, but no address to open', async () => {
  fake.nextDeviceApproval = { afterPolls: 1, email: EMAIL };
  const res = await cli(['kite', 'profile', 'add', '--json', '--no-browser', '--input', '-'], [JSON.stringify({ url: fake.url })]);
  expect(res.exitCode).toBe(0);
  expect(res.events.map((e) => e.event)).toEqual(['code', 'added']);
});

test('a closed stdin ends the run with an error event, not a hang', async () => {
  const res = await cli(['kite', 'profile', 'add', '--json']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Kite server URL"' });
});

test('bad --input is refused before any request reaches the server', async () => {
  for (const line of ['{"url":42}', `{"url":"${fake.url}","token":"x"}`, '{"url":"ftp://kite.example"}', 'not json']) {
    const res = await cli(['kite', 'profile', 'add', '--json', '--input', '-'], [line]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  }
  expect(fake.requests()).toEqual([]);
});

test('--input takes only "-"', async () => {
  const res = await cli(['kite', 'profile', 'add', '--json', '--input', '/etc/passwd']);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: '--input takes - (stdin)' });
});

test('a sign-in refused in the browser saves nothing and says so', async () => {
  fake.nextDeviceApproval = undefined;
  const run = cli(['kite', 'profile', 'add', '--json', '--input', '-'], [JSON.stringify({ url: fake.url })]);
  // Deny as soon as the code exists.
  for (let i = 0; i < 200 && fake.devices.size === 0; i++) await Bun.sleep(25);
  fake.deny([...fake.devices.values()][0].userCode);
  const res = await run;
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'AUTH_FAILED' });
  expect(res.events.some((e) => e.event === 'added')).toBe(false);
});

test('a plugin without declared needs refuses --json', async () => {
  const res = await cli(['slack', 'profile', 'add', '--json', '--profile', 'x']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', message: 'slack cannot be set up with --json yet', suggestion: 'Run: agentio slack profile add' });
});
