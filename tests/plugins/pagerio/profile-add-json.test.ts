import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import type { PagerioCredentials } from '../../../src/plugins/pagerio/types';

// A pager URL is itself the secret. The token is 16 letters and digits; the server is local.
const TOKEN = 'SECRETtoken12345';
const vault = withTempVault('agentio-pagerio-json-', () => ({ config: { profiles: {} } as never }));

let server: ReturnType<typeof Bun.serve>;
let requests: string[];
let pagerUrl: string;
beforeEach(() => {
  requests = [];
  // Like the real server: a body that is not JSON is a 400 invalid_input, which proves the URL is known.
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      requests.push(new URL(req.url).pathname);
      if (!req.url.endsWith(`/p/${TOKEN}`)) return Response.json({ error: { code: 'not_found', message: 'Unknown pager URL.' } }, { status: 404 });
      return Response.json({ error: { code: 'invalid_input', message: 'Body is not valid JSON.' } }, { status: 400 });
    },
  });
  pagerUrl = `http://127.0.0.1:${server.port}/p/${TOKEN}`;
});
afterEach(() => server.stop(true));

const cli = (args: string[], lines: string[] = []) => runCli(['pagerio', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: the pager URL, as a secret, no sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'pagerio', auth: 'none',
    inputs: [{ id: 'url', label: 'Pager URL', kind: 'secret', help: 'The Copy button on https://pagerio.chuut.com' }],
  }]);
}, 30_000);

test('bad --input is refused before any request, and the URL is never printed', async () => {
  const lines = [
    '{"url":42}',
    '{"url":"   "}',
    `{"url":"${pagerUrl}","key":"x"}`,
    `{"url":"${pagerUrl}?x=1"}`,
    `{"url":"${pagerUrl}#frag"}`,
    `{"url":"http://127.0.0.1:${server.port}/p/short"}`,
    'not json',
  ];
  for (const line of lines) {
    const res = await cli(['--json', '--input', '-'], [line]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'INVALID_PARAMS' })]);
    expect(res.stdout).not.toContain(TOKEN);
  }
  expect(requests).toEqual([]);
}, 90_000);

test('closed stdin with nothing given: the URL is named, nothing hangs', async () => {
  const res = await cli(['--json']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Pager URL"' });
  expect(requests).toEqual([]);
}, 30_000);

test('an unknown URL: one NOT_FOUND error, no profile, the URL is never printed', async () => {
  const unknown = `http://127.0.0.1:${server.port}/p/UNKNOWNtoken1234`;
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: unknown })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'NOT_FOUND' })]);
  expect(res.stdout).not.toContain('UNKNOWNtoken1234');
  expect(await getCredentials('pagerio', 'default')).toBeNull();
}, 30_000);

test('--json --input -: exactly one added event under the suggested name; the URL is never printed', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: pagerUrl })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'added', service: 'pagerio', profile: 'default', readOnly: false }]);
  expect(res.stdout).not.toContain(TOKEN);
  expect(await getCredentials<PagerioCredentials>('pagerio', 'default')).toEqual({ url: pagerUrl });
}, 30_000);

test('no value given: the URL is asked as a secret, with no value in the event, and its answer adds the profile', async () => {
  const res = await cli(['--json'], [JSON.stringify({ id: 'url', value: pagerUrl })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([
    { v: 1, event: 'ask', id: 'url', label: 'Pager URL', kind: 'secret', help: 'The Copy button on https://pagerio.chuut.com' },
    { v: 1, event: 'added', service: 'pagerio', profile: 'default', readOnly: false },
  ]);
  expect(res.stdout).not.toContain(TOKEN);
}, 30_000);

test('a flag wins over --input: the flag URL is the one contacted', async () => {
  const res = await cli(['--url', pagerUrl, '--json', '--input', '-'], [JSON.stringify({ url: 'https://other.example/p/OTHERtoken123456' })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'added' })]);
  expect(requests).toEqual([`/p/${TOKEN}`]);
}, 30_000);

test('a flag URL with a query string is refused before any request', async () => {
  const res = await cli(['--url', `${pagerUrl}?x=1`, '--json']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  expect(requests).toEqual([]);
}, 30_000);
