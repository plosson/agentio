import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { runCli } from '../helpers/cli';
import { FakeNotes, KEY } from './notes/fake-notes';
import { DEFAULT_PLUGIN_REGISTRY } from '../../src/plugins/registry';
import { isLegacyServicePlugin } from '../../src/plugins/types';

const vault = withTempVault('agentio-add-refusal-', () => ({ config: { profiles: {} } as never }));
let fake: FakeNotes;
beforeEach(() => { fake = new FakeNotes(); });
afterEach(() => fake.stop());

const cli = (args: string[]) => runCli(args, vault.env());

// Every plugin with a profile setup of its own; a session plugin (WhatsApp) is added by pairing.
const plugins = DEFAULT_PLUGIN_REGISTRY.profilePlugins()
  .filter((plugin) => !(isLegacyServicePlugin(plugin) && plugin.session));
const withoutNeeds = plugins.filter((plugin) => !plugin.profile?.needs).map((plugin) => plugin.id);
const withNeeds = plugins.filter((plugin) => plugin.profile?.needs);

/** A few processes at a time: fast, without starving each start-up of CPU. */
async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += 8) results.push(...await Promise.all(items.slice(i, i + 8).map(run)));
  return results;
}

test('the registry has plugins on both sides, so neither check below passes by being empty', () => {
  expect(withNeeds.map((p) => p.id)).toEqual(expect.arrayContaining(['kite', 'gmail', 'jira', 'dropbox']));
  expect(withoutNeeds).toEqual(['revolut']);
});

test('every service without declared needs refuses --describe --json and --json as one error event', async () => {
  const cases = withoutNeeds.flatMap((service) => [['--describe', '--json'], ['--json']].map((flags) => ({ service, flags })));
  const results = await inBatches(cases, async ({ service, flags }) => {
    const res = await cli([service, 'profile', 'add', ...flags]);
    return { service, flags, exitCode: res.exitCode, events: res.events };
  });
  for (const { service, flags, exitCode, events } of results) {
    expect({ service, flags, exitCode, events }).toEqual({
      service, flags, exitCode: 1,
      events: [{ v: 1, event: 'error', code: 'INVALID_PARAMS', message: `${service} cannot be set up with --json yet`, suggestion: `Run: agentio ${service} profile add` }],
    });
  }
}, 120_000);

test('every service with declared needs describes exactly the plugin\'s declaration, and the command agrees', async () => {
  const results = await inBatches(withNeeds, async (plugin) => {
    const res = await cli([plugin.id, 'profile', 'add', '--describe', '--json']);
    return { plugin, exitCode: res.exitCode, events: res.events };
  });
  for (const { plugin, exitCode, events } of results) {
    const needs = plugin.profile!.needs!;
    expect({ service: plugin.id, exitCode, events }).toEqual({
      service: plugin.id, exitCode: 0,
      // JSON round trip: the event carries plain data, not the constant's identity.
      events: [JSON.parse(JSON.stringify({ v: 1, event: 'needs', service: plugin.id, inputs: needs.inputs, auth: needs.auth }))],
    });
  }
}, 120_000);

test('--describe without --json is still refused for a plugin without needs', async () => {
  const res = await cli(['github', 'profile', 'add', '--describe']);
  expect(res.exitCode).not.toBe(0);
  expect(res.stderr).toContain('--describe needs --json');
}, 30_000);

test('the terminal flow of notes profile add is unchanged', async () => {
  const res = await cli(['notes', 'profile', 'add', '--url', fake.url, '--api-key', KEY, '--profile', 'main']);
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toContain('Profile "main" configured!');
}, 30_000);
