import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createSetupContext } from '../../src/plugins/host-context';
import { CliError } from '../../src/utils/errors';

// No opener on PATH, so no browser opens: the terminal context prints the address to open on stderr.
let err: string[];
const path = process.env.PATH;
const error = console.error;
beforeEach(() => {
  err = [];
  process.env.PATH = '/nonexistent';
  console.error = (...parts: unknown[]) => { err.push(parts.join(' ')); };
});
afterEach(() => {
  process.env.PATH = path;
  console.error = error;
});

/** The address the terminal context prints to open, once printed (it awaits a free port first). */
async function openedUrl(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const url = err.join('\n').match(/visit:\n(\S+)/)?.[1];
    if (url) return url;
    await Bun.sleep(5);
  }
  throw new Error('no address printed');
}

test('openUrl reports false when no browser can be opened', () => {
  expect(createSetupContext().openUrl('https://example.com/a?b=1')).toBe(false);
});

test('oauth: the callback server listens before the address is printed, and its code comes back', async () => {
  const ctx = createSetupContext();
  const result = ctx.oauth({
    serviceName: 'Test',
    expectedState: 'st8',
    authorizationUrl: (redirectUri) => `https://provider.example/auth?redirect_uri=${encodeURIComponent(redirectUri)}`,
  });
  // The server listens before the address is printed: fetch the callback as soon as it appears.
  const redirectUri = new URL(await openedUrl()).searchParams.get('redirect_uri')!;
  expect(redirectUri).toMatch(/^http:\/\/localhost:30(0\d|10)\/callback$/);
  await fetch(`${redirectUri}?code=abc&state=st8`);
  expect(await result).toEqual({ code: 'abc', state: 'st8', redirectUri });
});

test('oauth: a wrong state is refused', async () => {
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', expectedState: 'st8', authorizationUrl: (r) => `https://p.example/?r=${encodeURIComponent(r)}` });
  result.catch(() => {});
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
  await fetch(`${redirectUri}?code=abc&state=forged`);
  expect(await result.catch((e) => String(e))).toContain('state mismatch');
});

test('oauth: a fixed port is used as given', async () => {
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', port: 3009, authorizationUrl: (r) => `https://p.example/?r=${encodeURIComponent(r)}` });
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
  expect(redirectUri).toBe('http://localhost:3009/callback');
  await fetch(`${redirectUri}?code=c`);
  expect((await result).code).toBe('c');
});

const authUrl = (r: string) => `https://p.example/?r=${encodeURIComponent(r)}`;

test('oauth: a state mismatch rejects with an AUTH_FAILED CliError', async () => {
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', expectedState: 'st8', authorizationUrl: authUrl });
  const rejected = result.then(() => null, (e) => e);
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
  await fetch(`${redirectUri}?code=abc&state=forged`);
  const error = await rejected;
  expect(error).toBeInstanceOf(CliError);
  expect(error.code).toBe('AUTH_FAILED');
  expect(error.message).toContain('state mismatch');
  expect(error.suggestion).toBeTruthy();
});

test('oauth: a refused access (access_denied) rejects with an AUTH_FAILED CliError', async () => {
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', authorizationUrl: authUrl });
  const rejected = result.then(() => null, (e) => e);
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
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
    const ctx = createSetupContext();
    const error = await ctx.oauth({ serviceName: 'Test', port, authorizationUrl: authUrl }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.message).toContain(String(port));
    expect(error.suggestion).toBeTruthy();
  } finally {
    blocker.stop(true);
  }
});

/** A port nothing listens on: taken from the OS, then released. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

test('oauth: a busy fixed port on 127.0.0.1 is CONFIG_ERROR, and no address is printed', async () => {
  const blocker = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('busy') });
  const port = blocker.port!;
  try {
    const error = await createSetupContext().oauth({ serviceName: 'Test', port, host: '127.0.0.1', authorizationUrl: authUrl }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.message).toBe(`Test sign-in needs port ${port} on 127.0.0.1, and another program is using it`);
    expect(error.suggestion).toBe(`Stop the program using 127.0.0.1:${port}, then try again`);
    await Bun.sleep(20);
    expect(err.join('\n')).not.toContain('https://p.example');
  } finally {
    blocker.stop(true);
  }
});

test('oauth: with host 127.0.0.1, the redirect names it and the callback is reached there', async () => {
  const port = freePort();
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', port, host: '127.0.0.1', authorizationUrl: authUrl });
  const rejected = result.then(() => null, (e) => e);
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
  expect(redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  await fetch(`${redirectUri}?error=access_denied`);
  const error = await rejected;
  expect(error).toBeInstanceOf(CliError);
  expect(error.code).toBe('AUTH_FAILED');
  expect(error.message).toContain('access_denied');
});

test('oauth: without host, the redirect stays on localhost', async () => {
  const port = freePort();
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', port, authorizationUrl: authUrl });
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
  expect(redirectUri).toBe(`http://localhost:${port}/callback`);
  await fetch(`${redirectUri}?code=c`);
  expect(await result).toEqual({ code: 'c', state: undefined, redirectUri });
});

test('oauth: a provider\'s own callback path is listened on, and only it', async () => {
  const ctx = createSetupContext();
  const result = ctx.oauth({ serviceName: 'Test', path: '/auth/callback', authorizationUrl: authUrl });
  const redirectUri = new URL(await openedUrl()).searchParams.get('r')!;
  expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);
  expect((await fetch(redirectUri.replace('/auth/callback', '/callback') + '?code=x')).status).toBe(404);
  await fetch(`${redirectUri}?code=c`);
  expect((await result).code).toBe('c');
});

test('a terminal setup can run a program in the terminal, and it resolves to the exit code', async () => {
  const ctx = createSetupContext();
  expect(await ctx.runInTerminal(['/bin/sh', '-c', 'exit 3'])).toBe(3);
  expect(await ctx.runInTerminal(['/bin/sh', '-c', 'exit 0'])).toBe(0);
});
