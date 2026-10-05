import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { FakeNotes, KEY } from './notes/fake-notes';

const vault = withTempVault('agentio-add-refusal-', () => ({ config: { profiles: {} } as never }));
let fake: FakeNotes;
beforeEach(() => { fake = new FakeNotes(); });
afterEach(() => fake.stop());

async function cli(args: string[]) {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...vault.env(), NO_COLOR: '1' } });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stdout = await new Response(proc.stdout).text();
  return { exitCode, stdout, stderr: await new Response(proc.stderr).text(), events: stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) };
}

// slack is given without --profile: its refusal for a missing profile comes after the --json refusal.
for (const service of ['gcal', 'gchat', 'gdrive', 'gsheets', 'gdocs', 'gtasks', 'gslides', 'gscript', 'github', 'confluence', 'spotify', 'revolut', 'falco', 'discourse', 'sql', 'notes', 'pocketalert', 'pagerio', 'secrets', 'slack']) {
  for (const flags of [['--describe', '--json'], ['--json']]) {
    test(`${service} profile add ${flags.join(' ')} is refused as one error event`, async () => {
      const res = await cli([service, 'profile', 'add', ...flags]);
      expect(res.exitCode).toBe(1);
      expect(res.events).toEqual([{
        v: 1, event: 'error', code: 'INVALID_PARAMS',
        message: `${service} cannot be set up with --json yet`, suggestion: `Run: agentio ${service} profile add`,
      }]);
    }, 30_000);
  }
}

test('--describe without --json is still refused for a plugin without needs', async () => {
  const res = await cli(['github', 'profile', 'add', '--describe']);
  expect(res.exitCode).not.toBe(0);
  expect(res.stderr).toContain('--describe needs --json');
}, 30_000);

test('slack without --profile is still refused in the terminal flow', async () => {
  const res = await cli(['slack', 'profile', 'add']);
  expect(res.exitCode).toBe(1);
  expect(res.stderr).toContain('INVALID_PARAMS');
  expect(res.stderr).toContain('--profile');
}, 30_000);

test('the terminal flow of notes profile add is unchanged', async () => {
  const res = await cli(['notes', 'profile', 'add', '--url', fake.url, '--api-key', KEY, '--profile', 'main']);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('Profile "main" configured!');
}, 30_000);
