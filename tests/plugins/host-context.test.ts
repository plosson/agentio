import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PassThrough } from 'stream';
import { createJsonSetupContext } from '../../src/plugins/host-context';
import { createLineReader } from '../../src/utils/line-reader';
import { CliError } from '../../src/utils/errors';
import type { InputSpec } from '../../src/plugin-sdk';

let out: string[];
const write = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  out = [];
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
});
afterEach(() => { process.stdout.write = write; });
const events = () => out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const site: InputSpec = { id: 'site', label: 'Jira site', kind: 'choice', choices: [{ value: 'a1', label: 'Acme' }] };

/** The `open` event, once printed (the context awaits a free port first). */
async function openEvent(): Promise<{ url: string }> {
  for (let i = 0; i < 200; i++) {
    const open = events().find((e) => e.event === 'open');
    if (open) return open;
    await Bun.sleep(5);
  }
  throw new Error('no open event');
}

test('a value given in --input is used without asking', async () => {
  const ctx = createJsonSetupContext({ site: 'a1' }, createLineReader(new PassThrough()));
  expect(await ctx.ask(site)).toBe('a1');
  expect(events()).toEqual([]);
});

test('a missing value is asked as an event, and the answer line is checked', async () => {
  const input = new PassThrough();
  const ctx = createJsonSetupContext({}, createLineReader(input));
  const answer = ctx.ask(site);
  input.write('{"id":"site","value":"a1"}\n');
  expect(await answer).toBe('a1');
  expect(events()).toEqual([{ v: 1, event: 'ask', id: 'site', label: 'Jira site', kind: 'choice', choices: [{ value: 'a1', label: 'Acme' }] }]);
});

test('a closed stdin fails the question instead of hanging', async () => {
  const input = new PassThrough();
  const ctx = createJsonSetupContext({}, createLineReader(input));
  input.end();
  const err = await ctx.ask(site).catch((e) => e);
  expect(err).toBeInstanceOf(CliError);
  expect((err as CliError).message).toBe('No answer for "Jira site"');
});

test('openUrl prints the address and opens nothing', () => {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
    expect(ctx.openUrl('https://example.com/a?b=1')).toBe(true);
  } finally {
    process.env.PATH = path;
  }
  expect(events()).toEqual([{ v: 1, event: 'open', url: 'https://example.com/a?b=1' }]);
});

test('oauth: the callback server listens before the address is printed, and its code comes back', async () => {
  const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
  const result = ctx.oauth({
    serviceName: 'Test',
    expectedState: 'st8',
    authorizationUrl: (redirectUri) => `https://provider.example/auth?redirect_uri=${encodeURIComponent(redirectUri)}`,
  });
  // The server listens before the event is printed: fetch the callback as soon as it appears.
  const open = await openEvent();
  const redirectUri = new URL(open.url).searchParams.get('redirect_uri')!;
  expect(redirectUri).toMatch(/^http:\/\/localhost:30(0\d|10)\/callback$/);
  await fetch(`${redirectUri}?code=abc&state=st8`);
  expect(await result).toEqual({ code: 'abc', state: 'st8', redirectUri });
});

test('oauth: a wrong state is refused', async () => {
  const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
  const result = ctx.oauth({ serviceName: 'Test', expectedState: 'st8', authorizationUrl: (r) => `https://p.example/?r=${encodeURIComponent(r)}` });
  result.catch(() => {});
  const redirectUri = new URL((await openEvent()).url).searchParams.get('r')!;
  await fetch(`${redirectUri}?code=abc&state=forged`);
  expect(await result.catch((e) => String(e))).toContain('state mismatch');
});

test('oauth: a fixed port is used as given', async () => {
  const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
  const result = ctx.oauth({ serviceName: 'Test', port: 3009, authorizationUrl: (r) => `https://p.example/?r=${encodeURIComponent(r)}` });
  const redirectUri = new URL((await openEvent()).url).searchParams.get('r')!;
  expect(redirectUri).toBe('http://localhost:3009/callback');
  await fetch(`${redirectUri}?code=c`);
  expect((await result).code).toBe('c');
});

const authUrl = (r: string) => `https://p.example/?r=${encodeURIComponent(r)}`;

test('oauth: a state mismatch rejects with an AUTH_FAILED CliError', async () => {
  const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
  const result = ctx.oauth({ serviceName: 'Test', expectedState: 'st8', authorizationUrl: authUrl });
  const rejected = result.then(() => null, (e) => e);
  const redirectUri = new URL((await openEvent()).url).searchParams.get('r')!;
  await fetch(`${redirectUri}?code=abc&state=forged`);
  const error = await rejected;
  expect(error).toBeInstanceOf(CliError);
  expect(error.code).toBe('AUTH_FAILED');
  expect(error.message).toContain('state mismatch');
  expect(error.suggestion).toBeTruthy();
});

test('oauth: a refused access (access_denied) rejects with an AUTH_FAILED CliError', async () => {
  const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
  const result = ctx.oauth({ serviceName: 'Test', authorizationUrl: authUrl });
  const rejected = result.then(() => null, (e) => e);
  const redirectUri = new URL((await openEvent()).url).searchParams.get('r')!;
  await fetch(`${redirectUri}?error=access_denied`);
  const error = await rejected;
  expect(error).toBeInstanceOf(CliError);
  expect(error.code).toBe('AUTH_FAILED');
  expect(error.message).toContain('access_denied');
});

test('oauth: a busy fixed port rejects with a CONFIG_ERROR CliError naming the port', async () => {
  const port = 38417;
  const blocker = Bun.serve({ port, fetch: () => new Response('busy') });
  try {
    const ctx = createJsonSetupContext({}, createLineReader(new PassThrough()));
    const error = await ctx.oauth({ serviceName: 'Test', port, authorizationUrl: authUrl }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.message).toContain(String(port));
    expect(error.suggestion).toBeTruthy();
  } finally {
    blocker.stop(true);
  }
});
