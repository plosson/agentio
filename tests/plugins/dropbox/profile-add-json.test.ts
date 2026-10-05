import { expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';

const vault = withTempVault('agentio-dropbox-json-', () => ({ config: { profiles: {} } as never }));

const run = (args: string[], lines: string[]) => runCli(['dropbox', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: an app key, then a code from the browser', async () => {
  const { exitCode, events } = await run(['--describe', '--json'], []);
  expect(exitCode).toBe(0);
  expect(events).toEqual([{
    v: 1, event: 'needs', service: 'dropbox', auth: 'browser-code',
    inputs: [{ id: 'appKey', label: 'App key', kind: 'text', help: 'From your app at https://www.dropbox.com/developers/apps (Settings tab)' }],
  }]);
}, 20_000);

test('--json: the authorise address carries the app key and a PKCE challenge; then the code is asked', async () => {
  // stdin closes after the inputs line, so the code question fails: nothing reaches Dropbox's token endpoint.
  const { exitCode, events } = await run(['--json', '--input', '-'], [JSON.stringify({ appKey: 'my-app-key' })]);
  expect(exitCode).not.toBe(0);
  const open = new URL(events[0].url);
  expect(events[0].event).toBe('open');
  expect(open.searchParams.get('client_id')).toBe('my-app-key');
  expect(open.searchParams.get('code_challenge_method')).toBe('S256');
  expect(events[1]).toEqual({ v: 1, event: 'ask', id: 'code', label: 'Code Dropbox shows after you allow access', kind: 'secret' });
  expect(events[2]).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Code Dropbox shows after you allow access"' });
}, 20_000);

test('an empty app key is refused before anything is opened', async () => {
  const { events } = await run(['--json', '--input', '-'], ['{"appKey":"  "}']);
  expect(events).toEqual([expect.objectContaining({ event: 'error', message: 'App key is required' })]);
}, 20_000);
