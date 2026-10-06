import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { getCredentials } from '../../../src/auth/token-store';
import { checkAnswer } from '../../../src/plugins/setup-inputs';
import { NOTES_URL_INPUT } from '../../../src/plugins/notes/setup-needs';
import type { NotesCredentials } from '../../../src/plugins/notes/types';
import { FakeNotes, KEY } from './fake-notes';

const SECRET = 'SECRET-KEY-123';
const vault = withTempVault('agentio-notes-json-', () => ({ config: { profiles: {} } as never }));
let fake: FakeNotes;
beforeEach(() => { fake = new FakeNotes(); });
afterEach(() => fake.stop());

const cli = (args: string[], lines: string[] = []) => runCli(['notes', 'profile', 'add', ...args], vault.env(), lines);

test('--describe --json: the server URL and the API key, no sign-in', async () => {
  const res = await cli(['--describe', '--json']);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{
    v: 1, event: 'needs', service: 'notes', auth: 'none',
    inputs: [
      { id: 'url', label: 'Notes server URL', kind: 'url', help: 'For example https://mac-mini.example.ts.net' },
      { id: 'apiKey', label: 'API key', kind: 'secret', help: 'NOTES_API_KEY on the Mac that runs apple-notes-api' },
    ],
  }]);
  expect(fake.log).toEqual([]);
}, 30_000);

test('bad --input is refused before any request', async () => {
  const lines = [
    `{"url":42,"apiKey":"${KEY}"}`,
    `{"url":"ftp://mac","apiKey":"${KEY}"}`,
    `{"url":"${fake.url}","apiKey":"   "}`,
    `{"url":"${fake.url}","apiKey":"${KEY}","token":"x"}`,
    'not json',
  ];
  for (const line of lines) {
    const res = await cli(['--json', '--input', '-'], [line]);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  }
  expect(fake.log).toEqual([]);
}, 60_000);

test('closed stdin with nothing given: the first missing value is named, nothing hangs', async () => {
  const res = await cli(['--json']);
  expect(res.exitCode).not.toBe(0);
  expect(res.events.at(-1)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'No answer for "Notes server URL"' });
  expect(fake.log).toEqual([]);
}, 30_000);

test('a wrong key: one AUTH_FAILED error, no profile, and the key is never printed', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: fake.url, apiKey: SECRET })]);
  expect(res.exitCode).not.toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'error', code: 'AUTH_FAILED' })]);
  expect(res.stdout).not.toContain(SECRET);
  expect(await getCredentials('notes', '127.0.0.1')).toBeNull();
}, 30_000);

test('--json --input -: exactly one added event, the credentials are stored, the key is never printed', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: fake.url, apiKey: KEY })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([{ v: 1, event: 'added', service: 'notes', profile: '127.0.0.1', readOnly: false }]);
  expect(res.stdout).not.toContain(KEY);
  expect(await getCredentials<NotesCredentials>('notes', '127.0.0.1')).toEqual({ baseUrl: fake.url, apiKey: KEY });
}, 30_000);

test('only the URL given: the key is asked as a secret, with no value in the event, and its answer adds the profile', async () => {
  const res = await cli(['--json', '--input', '-'], [JSON.stringify({ url: fake.url }), JSON.stringify({ id: 'apiKey', value: KEY })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([
    { v: 1, event: 'ask', id: 'apiKey', label: 'API key', kind: 'secret', help: 'NOTES_API_KEY on the Mac that runs apple-notes-api' },
    { v: 1, event: 'added', service: 'notes', profile: '127.0.0.1', readOnly: false },
  ]);
  expect(res.stdout).not.toContain(KEY);
}, 30_000);

test('a flag wins over --input: the flag URL is the one contacted', async () => {
  const res = await cli(['--url', fake.url, '--json', '--input', '-'], [JSON.stringify({ url: 'https://other.example', apiKey: KEY })]);
  expect(res.exitCode).toBe(0);
  expect(res.events).toEqual([expect.objectContaining({ event: 'added', profile: '127.0.0.1' })]);
  expect(fake.log.length).toBeGreaterThan(0);
  expect((await getCredentials<NotesCredentials>('notes', '127.0.0.1'))?.baseUrl).toBe(fake.url);
}, 30_000);

test('a URL without a scheme is completed with https', () => {
  expect(checkAnswer(NOTES_URL_INPUT, 'mac-mini.example.ts.net')).toBe('https://mac-mini.example.ts.net');
  expect(checkAnswer(NOTES_URL_INPUT, `localhost:${fake.url.split(':').pop()}`)).toMatch(/^https:\/\/localhost:\d+$/);
});
