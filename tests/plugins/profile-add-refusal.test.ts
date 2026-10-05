import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { runCli } from '../helpers/cli';
import { FakeNotes, KEY } from './notes/fake-notes';

const vault = withTempVault('agentio-add-refusal-', () => ({ config: { profiles: {} } as never }));
let fake: FakeNotes;
beforeEach(() => { fake = new FakeNotes(); });
afterEach(() => fake.stop());

const cli = (args: string[]) => runCli(args, vault.env());

// slack is given without --profile: its refusal for a missing profile comes after the --json refusal.
const SERVICES = ['gcal', 'gchat', 'gdrive', 'gsheets', 'gdocs', 'gtasks', 'gslides', 'gscript', 'github', 'confluence', 'spotify', 'revolut', 'falco', 'discourse', 'sql', 'notes', 'pocketalert', 'pagerio', 'secrets', 'slack'];

test('every service without declared needs refuses --describe --json and --json as one error event', async () => {
  const cases = SERVICES.flatMap((service) => [['--describe', '--json'], ['--json']].map((flags) => ({ service, flags })));
  // A few processes at a time: fast, without starving each start-up of CPU.
  const results = [];
  for (let i = 0; i < cases.length; i += 8) {
    results.push(...await Promise.all(cases.slice(i, i + 8).map(async ({ service, flags }) => {
      const res = await cli([service, 'profile', 'add', ...flags]);
      return { service, flags, exitCode: res.exitCode, events: res.events };
    })));
  }
  for (const { service, flags, exitCode, events } of results) {
    expect({ service, flags, exitCode, events }).toEqual({
      service, flags, exitCode: 1,
      events: [{ v: 1, event: 'error', code: 'INVALID_PARAMS', message: `${service} cannot be set up with --json yet`, suggestion: `Run: agentio ${service} profile add` }],
    });
  }
}, 120_000);

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
