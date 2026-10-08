import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { fakeSetupContext } from '../../helpers/setup-context';
import { NOTES_URL_INPUT, notesProfileAdd, suggestedName } from '../../../src/plugins/notes/commands';
import { addProfileWithSetup } from '../../../src/plugins/profile-host';
import { getCredentials } from '../../../src/auth/token-store';
import { checkAnswer } from '../../../src/plugins/setup-inputs';
import type { NotesCredentials } from '../../../src/plugins/notes/types';
import { caught, FakeNotes, KEY } from './fake-notes';

// The installed agentio's folder, as it is before any test runs.
const REAL_CONFIG = join(process.env.HOME || homedir(), '.config', 'agentio');
function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent';
  return readdirSync(dir).sort().map((name) => {
    const s = statSync(join(dir, name));
    return `${name}:${s.size}:${s.mtimeMs}`;
  }).join('|');
}
const REAL_BEFORE = snapshot(REAL_CONFIG);

withTempVault('agentio-notes-setup-', () => ({ config: { profiles: {} } as never }));

let fake: FakeNotes;
let errors: string[];
let fetched: string[];
const originalFetch = globalThis.fetch;
const originalError = console.error;
const originalLog = console.log;

// No answers: any question fails, so a value given as an option is never asked for.
const noPrompt = () => fakeSetupContext({});

beforeEach(() => {
  fake = new FakeNotes();
  errors = [];
  fetched = [];
  // Only the fake may be reached; anything else fails without leaving the machine.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (!url.startsWith(fake.url)) throw new TypeError(`blocked: ${url}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  console.log = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  console.log = originalLog;
  fake.stop();
});

afterAll(() => {
  expect(snapshot(REAL_CONFIG)).toBe(REAL_BEFORE);
});

test('setup checks the server and the key, and returns normalised credentials', async () => {
  const result = await notesProfileAdd({ url: `${fake.url}//`, apiKey: ` ${KEY} ` }, noPrompt());
  expect(result.credentials).toEqual({ baseUrl: fake.url, apiKey: KEY });
  expect(result.info).toContain('2 folders');
  expect(fake.log.map((r) => r.rawPath)).toEqual(['/health', '/v1/folders']);
  expect(fake.log[0].authorization).toBeNull();
});

test('a wrong key stops setup and nothing is returned to save; the key is never in the error', async () => {
  const secret = 'SECRET-KEY-123';
  const err = await caught(notesProfileAdd({ url: fake.url, apiKey: secret }, noPrompt()));
  expect(err.code).toBe('AUTH_FAILED');
  expect(`${err.message} ${err.suggestion ?? ''}`).not.toContain(secret);
  expect(errors.join('\n')).not.toContain(secret);
});

test('a key that works while Notes.app does not answer is kept, with a warning', async () => {
  fake.failNext = { status: 502, body: { error: 'NotesError', message: 'osascript timed out' } };
  const logged: string[] = [];
  const context = { ...noPrompt(), log: (...parts: unknown[]) => { logged.push(parts.join(' ')); } };
  const result = await notesProfileAdd({ url: fake.url, apiKey: KEY }, context);
  expect(result.credentials.apiKey).toBe(KEY);
  expect(logged.join('\n')).toContain('Notes.app did not answer');
  expect(errors).toEqual([]);
  expect(result.info).not.toContain('folders');
});

test('a server on another platform is refused', async () => {
  fake.platform = 'linux';
  const err = await caught(notesProfileAdd({ url: fake.url, apiKey: KEY }, noPrompt()));
  expect(err.code).toBe('CONFIG_ERROR');
});

test('a URL that is not an apple-notes-api server is refused before the key is sent', async () => {
  const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ hello: 'world' }) });
  const otherUrl = `http://127.0.0.1:${other.port}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input));
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const err = await caught(notesProfileAdd({ url: otherUrl, apiKey: KEY }, noPrompt()));
    expect(err.code).toBe('CONFIG_ERROR');
    expect(fetched).toEqual([`${otherUrl}/health`]);
  } finally {
    other.stop(true);
  }
});

test('bad URLs and an empty key are refused before any request', async () => {
  for (const url of ['ftp://mac', '  ', 'https://u:p@mac']) {
    expect((await caught(notesProfileAdd({ url, apiKey: KEY }, noPrompt()))).code).toBe('INVALID_PARAMS');
  }
  expect((await caught(notesProfileAdd({ url: fake.url, apiKey: '   ' }, noPrompt()))).code).toBe('INVALID_PARAMS');
  expect(fetched).toEqual([]);
});

test('without --url and --api-key both are asked for', async () => {
  const context = fakeSetupContext({ 'Notes server URL': fake.url, 'API key': KEY });
  const result = await notesProfileAdd({}, context);
  expect(context.asked.map((s) => s.label)).toEqual(['Notes server URL', 'API key']);
  expect(context.asked[1].kind).toBe('secret');
  expect(result.credentials).toEqual({ baseUrl: fake.url, apiKey: KEY });
});

test('the profile is saved in the vault under the host name', async () => {
  await addProfileWithSetup('notes', (o) => notesProfileAdd({ ...o, url: fake.url, apiKey: KEY }, noPrompt()), {});
  expect(await getCredentials<NotesCredentials>('notes', '127.0.0.1')).toEqual({ baseUrl: fake.url, apiKey: KEY });
});

test('a URL without a scheme is completed with https', () => {
  expect(checkAnswer(NOTES_URL_INPUT, 'mac-mini.example.ts.net')).toBe('https://mac-mini.example.ts.net');
  expect(checkAnswer(NOTES_URL_INPUT, `localhost:${fake.url.split(':').pop()}`)).toMatch(/^https:\/\/localhost:\d+$/);
});

test('suggestedName uses the first host label, or the whole address for an IP', () => {
  expect(suggestedName('https://macmini.tail1234.ts.net')).toBe('macmini');
  expect(suggestedName('http://127.0.0.1:8787')).toBe('127.0.0.1');
  expect(suggestedName('http://[::1]:8787')).toBe('[::1]');
});
