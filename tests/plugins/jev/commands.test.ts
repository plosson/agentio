import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { exitCodeForError } from '../../../src/utils/errors';
import { YESNO_ERROR_EXIT } from '../../../src/plugins/jev/commands';
import { KEY } from './fake-api';

let vault: ReturnType<typeof withTempVault>;
function withProfiles(names: string[]): void {
  const own = withTempVault('agentio-jev-cli-', () => ({
    config: { profiles: { jev: names.map((name) => ({ name })) } } as never,
    credentials: { jev: Object.fromEntries(names.map((name) => [name, { apiKey: KEY }])) } as never,
  }));
  beforeEach(() => { vault = own; });
}

const cli = (args: string[], stdin: string[] = [], noul = '0.9') => runCli(['jev', ...args], {
  ...vault.env(),
  BUN_OPTIONS: `--preload=${join(import.meta.dir, 'stub-api-preload.ts')}`,
  STUB_JEV_KEY: KEY,
  STUB_JEV_NOUL: noul,
}, stdin);

describe('yesno', () => {
  withProfiles(['main']);

  test('yes exits 0, no exits 1, and a probability exactly at the threshold is yes', async () => {
    const yes = await cli(['yesno', 'Urgent?'], ['ticket'], '0.9');
    expect([yes.exitCode, yes.stdout.trim()]).toEqual([0, 'yes 0.90']);
    const no = await cli(['yesno', 'Urgent?'], ['ticket'], '0.2');
    expect([no.exitCode, no.stdout.trim()]).toEqual([1, 'no 0.20']);
    const edge = await cli(['yesno', 'Urgent?', '--threshold', '0.5'], ['ticket'], '0.5');
    expect(edge.exitCode).toBe(0);
  }, 60_000);

  test('an error that would exit 1 exits 6, so a script never reads it as "no"', async () => {
    for (const [args, stdin] of [
      [['yesno', 'Urgent?'], []],                              // no input
      [['yesno', '  '], ['x']],                                // blank question
      [['yesno', 'Urgent?', '--threshold', 'abc'], ['x']],     // bad threshold
      [['yesno', 'Urgent?', '--state', 'a'], ['b']],           // both inputs
    ] as Array<[string[], string[]]>) {
      const res = await cli(args, stdin);
      expect(res.exitCode).toBe(YESNO_ERROR_EXIT);
      expect(res.stdout).toBe('');
    }
  }, 60_000);

  test('a usage error Commander catches exits 6 too, and --help still exits 0', async () => {
    for (const args of [
      ['yesno'],                                  // missing question
      ['yesno', 'Urgent?', '--treshold', '0.8'],  // unknown option
      ['yesno', 'Urgent?', '--threshold'],        // option without its value
    ]) {
      const res = await cli(args, ['x']);
      expect(res.exitCode).toBe(YESNO_ERROR_EXIT);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('error:');
    }
    const help = await cli(['yesno', '--help'], []);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage:');
  }, 60_000);

  test('--json with an error exits 6', async () => {
    const res = await cli(['yesno', 'Urgent?', '--json'], []);
    expect(res.exitCode).toBe(YESNO_ERROR_EXIT);
    expect(res.events[0]).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  }, 30_000);

  test('other errors keep their codes', async () => {
    const res = await cli(['yesno', 'Urgent?', '--profile', 'other'], ['x']);
    expect(res.exitCode).toBe(exitCodeForError('PROFILE_NOT_FOUND'));
  }, 30_000);

  test('--json prints the answer with its model, and still exits by the answer', async () => {
    const res = await cli(['yesno', 'Urgent?', '--json'], ['x'], '0.1');
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({ type: 'noul', noul: 0.1, model: 'jev-1.13.0', usage: { input_tokens: 3, output_tokens: 0 } });
  }, 30_000);
});

describe('choice and score', () => {
  withProfiles(['main']);

  test('choice prints the key and confidence; too few options exit 1 before any request', async () => {
    const res = await cli(['choice', 'Team?', '--option', 'billing=Money', '--option', 'shipping=Parcels'], ['x']);
    expect([res.exitCode, res.stdout.trim()]).toEqual([0, 'billing 0.91']);
    const bad = await cli(['choice', 'Team?', '--option', 'billing=Money'], ['x']);
    expect(bad.exitCode).toBe(exitCodeForError('INVALID_PARAMS'));
  }, 60_000);

  test('score prints the score and confidence', async () => {
    const res = await cli(['score', 'Severity?', '--level', 'low', '--level', 'high'], ['x']);
    expect([res.exitCode, res.stdout.trim()]).toEqual([0, '1.3 (confidence 0.54)']);
  }, 30_000);
});
