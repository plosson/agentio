import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spotifyProfileAdd } from '../../../src/plugins/spotify/commands';
import spotifyPlugin from '../../../src/plugins/spotify';
import { authorizeSpotify, SPOTIFY_REDIRECT_URI } from '../../../src/plugins/spotify/oauth';
import type { OAuthSetupOptions, SetupContext } from '../../../src/plugin-sdk';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';

const vault = withTempVault('agentio-spotify-json-', () => ({ config: { profiles: {} } as never }));

type Call = { url: string; body?: string };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Spotify's token endpoint and /me, answered here; every call recorded. */
function stubSpotify(calls: Call[], token: Record<string, unknown> = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    if (String(url) === 'https://accounts.spotify.com/api/token') return new Response(JSON.stringify(token), { status: 200 });
    if (String(url) === 'https://api.spotify.com/v1/me') return new Response(JSON.stringify({ id: 'spotty', display_name: 'Spot Ty' }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** A context whose oauth records its options and answers with code `c` on Spotify's address. */
function oauthContext(answers: Record<string, string> = {}, seen: OAuthSetupOptions[] = []): SetupContext & { asked: unknown[] } {
  return {
    ...fakeSetupContext(answers),
    async oauth(options) { seen.push(options); return { code: 'c', redirectUri: SPOTIFY_REDIRECT_URI }; },
  };
}

/** A context for --no-browser: the logged address is kept, and `redirect` is answered from it. */
function pasteContext(paste: (state: string) => string, logged: string[] = []): SetupContext & { asked: { id: string }[] } {
  const base = fakeSetupContext({});
  return {
    ...base,
    log: (...parts) => { logged.push(parts.join(' ')); },
    async ask(spec) {
      base.asked.push(spec);
      if (spec.id !== 'redirect') throw new Error(`unexpected question: ${spec.id}`);
      const address = logged.join('\n').match(/https:\/\/accounts\.spotify\.com\/authorize\?\S+/)![0];
      return paste(new URL(address).searchParams.get('state')!);
    },
  };
}

describe('authorizeSpotify', () => {
  test('the callback is Spotify\'s fixed 127.0.0.1:3010, and the code is exchanged with that address', async () => {
    const calls: Call[] = [];
    stubSpotify(calls);
    const seen: OAuthSetupOptions[] = [];
    const tokens = await authorizeSpotify({ clientId: 'abc', readOnly: true }, oauthContext({}, seen));
    expect(seen[0]).toMatchObject({ serviceName: 'Spotify', port: 3010, host: '127.0.0.1' });
    const url = new URL(seen[0].authorizationUrl(SPOTIFY_REDIRECT_URI));
    expect(url.host).toBe('accounts.spotify.com');
    expect(url.searchParams.get('state')).toBe(seen[0].expectedState!);
    expect(url.searchParams.get('scope')).not.toContain('modify');
    const body = new URLSearchParams(calls[0].body);
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:3010/callback');
    expect(body.get('code')).toBe('c');
    expect(tokens.refreshToken).toBe('new-refresh');
  });

  test('--no-browser: a pasted address with the wrong state is refused, and no token is requested', async () => {
    const calls: Call[] = [];
    stubSpotify(calls);
    const ctx = pasteContext(() => 'http://127.0.0.1:3010/callback?code=x&state=forged');
    await expect(authorizeSpotify({ clientId: 'abc', readOnly: false, noBrowser: true }, ctx)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calls).toEqual([]);
  });

  test('--no-browser: the address is logged, `redirect` is asked, and a pasted address is exchanged', async () => {
    const calls: Call[] = [];
    stubSpotify(calls);
    const logged: string[] = [];
    const ctx = pasteContext((state) => `http://127.0.0.1:3010/callback?code=x&state=${state}`, logged);
    const tokens = await authorizeSpotify({ clientId: 'abc', readOnly: false, noBrowser: true }, ctx);
    expect(ctx.asked.map((spec) => spec.id)).toEqual(['redirect']);
    expect(tokens.accessToken).toBe('new-access');
    const body = new URLSearchParams(calls[0].body);
    expect(body.get('code')).toBe('x');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:3010/callback');
  });
});

describe('Spotify setup and sign in again', () => {
  test('a --client-id flag is checked like an answer: blank is refused before any sign-in', async () => {
    await expect(spotifyProfileAdd({ clientId: '   ' }, oauthContext())).rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'Client ID is required' });
  });

  test('setup asks the client ID through the context and returns the account', async () => {
    stubSpotify([]);
    const ctx = oauthContext({ clientId: ' abc ' });
    const result = await spotifyProfileAdd({}, ctx);
    expect(ctx.asked.map((spec) => (spec as { id: string }).id)).toEqual(['clientId']);
    expect(result.credentials).toMatchObject({ clientId: 'abc', refreshToken: 'new-refresh', userId: 'spotty', readOnly: false });
    expect(result.suggestedProfileName).toBe('spotty');
  });

  test('reauth does not read the existing refresh token: it keeps clientId, readOnly and scopes, and gets new tokens', async () => {
    stubSpotify([]);
    const seen: OAuthSetupOptions[] = [];
    const redacted = { clientId: 'cid', readOnly: true, scopes: ['user-read-private'], userId: 'old', accessToken: 'old', expiryDate: 0, authorizedAt: '2020-01-01T00:00:00.000Z' } as never;
    const result = await spotifyPlugin.profile!.reauthenticate!(redacted, 'p', oauthContext({}, seen));
    expect(new URL(seen[0].authorizationUrl(SPOTIFY_REDIRECT_URI)).searchParams.get('client_id')).toBe('cid');
    expect(result).toMatchObject({
      clientId: 'cid',
      readOnly: true,
      scopes: ['user-read-private'],
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      userId: 'spotty',
    });
    expect(result.authorizedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  test('reauth without a client ID is AUTH_FAILED, before any sign-in', async () => {
    await expect(spotifyPlugin.profile!.reauthenticate!(null, 'p', fakeSetupContext({}))).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});

/** Whether Spotify's fixed callback port is free on this machine. */
function port3010Free(): boolean {
  try {
    Bun.serve({ port: 3010, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

const portFree = port3010Free();
if (!portFree) console.warn('Skipping the Spotify --json sign-in tests: port 3010 on 127.0.0.1 is in use on this machine');

/** A PATH whose `open` and `xdg-open` leave a mark, so an opened browser shows. */
async function fakeOpeners(): Promise<{ path: string; mark: string }> {
  const bin = await mkdtemp(join(tmpdir(), 'agentio-bin-'));
  const mark = join(bin, 'opened');
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "$@" > "${mark}"\n`);
    await chmod(join(bin, name), 0o755);
  }
  return { path: `${bin}:${process.env.PATH}`, mark };
}

/** Read stdout up to the end of its first line. */
async function firstLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ line: string; rest: string }> {
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const at = text.indexOf('\n');
  return { line: text.slice(0, at), rest: text.slice(at + 1) };
}

/** Run `spotify profile add --json --input -` with `inputs`; the first event must be `open`; deny it. */
async function runDenied(inputs: string, extra: string[] = []): Promise<{ url: URL; error: Record<string, unknown>; opened: boolean }> {
  const { path, mark } = await fakeOpeners();
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'spotify', 'profile', 'add', '--json', '--input', '-', ...extra], {
    stdin: new Blob([`${inputs}\n`]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), PATH: path },
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const reader = proc.stdout.getReader();
  const { line, rest: first } = await firstLine(reader);
  const event = JSON.parse(line);
  expect(event.event).toBe('open');
  const url = new URL(event.url);
  const res = await fetch('http://127.0.0.1:3010/callback?error=access_denied');
  expect(res.status).toBe(200);
  expect(await proc.exited).toBe(2);
  clearTimeout(timer);
  let rest = first;
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  const error = rest.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'error');
  return { url, error, opened: existsSync(mark) };
}

describe('spotify profile add --json', () => {
  test('--describe --json: the client ID, then a browser sign-in', async () => {
    const res = await runCli(['spotify', 'profile', 'add', '--describe', '--json'], vault.env());
    expect(res.exitCode).toBe(0);
    expect(res.events).toEqual([{
      v: 1,
      event: 'needs',
      service: 'spotify',
      inputs: [{ id: 'clientId', label: 'Client ID', kind: 'text', help: 'From your app at https://developer.spotify.com/dashboard (redirect URI http://127.0.0.1:3010/callback)' }],
      auth: 'browser',
    }]);
  }, 20_000);

  test('a blank client ID is refused before anything opens', async () => {
    const res = await runCli(['spotify', 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"clientId":"   "}']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS', message: 'Client ID is required' });
  }, 20_000);

  test('an unknown input id is refused before anything opens', async () => {
    const res = await runCli(['spotify', 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"redirect":"x"}']);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS', message: 'Unknown setup value "redirect"' });
  }, 20_000);

  test('stdin closed with no client ID ends with "No answer", never hangs', async () => {
    const res = await runCli(['spotify', 'profile', 'add', '--json'], vault.env());
    expect(res.events.map((e) => e.event)).toEqual(['ask', 'error']);
    expect(res.events[1]).toMatchObject({ code: 'INVALID_PARAMS', message: 'No answer for "Client ID"' });
  }, 20_000);

  test.skipIf(!portFree)('the Spotify address comes first, nothing is opened, and a denied callback is AUTH_FAILED', async () => {
    const { url, error, opened } = await runDenied('{"clientId":"abc"}');
    expect(url.host).toBe('accounts.spotify.com');
    expect(url.searchParams.get('client_id')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3010/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(error).toMatchObject({ code: 'AUTH_FAILED' });
    expect(String(error.message)).toContain('access_denied');
    expect(opened).toBe(false);
  }, 20_000);

  test.skipIf(!portFree)('--client-id wins over the input line, and --no-browser changes nothing in JSON mode', async () => {
    const { url, error } = await runDenied('{"clientId":"from-input"}', ['--client-id', 'from-flag', '--no-browser']);
    expect(url.searchParams.get('client_id')).toBe('from-flag');
    expect(error).toMatchObject({ code: 'AUTH_FAILED' });
  }, 20_000);

  test.skipIf(!portFree)('port 3010 taken: one CONFIG_ERROR event and no open event', async () => {
    const blocker = Bun.serve({ port: 3010, hostname: '127.0.0.1', fetch: () => new Response('busy') });
    try {
      const res = await runCli(['spotify', 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"clientId":"abc"}'], 15_000);
      expect(res.events).toEqual([{
        v: 1,
        event: 'error',
        code: 'CONFIG_ERROR',
        message: 'Spotify sign-in needs port 3010 on 127.0.0.1, and another program is using it',
        suggestion: 'Stop the program using 127.0.0.1:3010, then try again',
      }]);
    } finally {
      blocker.stop(true);
    }
  }, 20_000);
});
