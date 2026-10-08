import { afterEach, describe, expect, test } from 'bun:test';
import { dirname } from 'path';
import { spotifyProfileAdd } from '../../../src/plugins/spotify/commands';
import spotifyPlugin from '../../../src/plugins/spotify';
import { authorizeSpotify, SPOTIFY_REDIRECT_URI } from '../../../src/plugins/spotify/oauth';
import { REDIRECT_INPUT, SPOTIFY_CLIENT_ID_INPUT } from '../../../src/plugins/spotify/setup-questions';
import type { InputSpec, OAuthSetupOptions, SetupContext } from '../../../src/plugin-sdk';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { spawnCli } from '../../helpers/cli';

const vault = withTempVault('agentio-spotify-setup-', () => ({ config: { profiles: {} } as never }));

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

/** A context for --no-browser: the logged address is kept, and the redirect question is answered from it. */
function pasteContext(paste: (state: string) => string, logged: string[] = []): SetupContext & { asked: InputSpec[] } {
  const base = fakeSetupContext({});
  return {
    ...base,
    log: (...parts) => { logged.push(parts.join(' ')); },
    async ask(spec) {
      base.asked.push(spec);
      if (spec !== REDIRECT_INPUT) throw new Error(`unexpected question: ${spec.label}`);
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
    expect(ctx.asked).toEqual([REDIRECT_INPUT]);
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
    const ctx = oauthContext({ 'Client ID': ' abc ' });
    const result = await spotifyProfileAdd({}, ctx);
    expect(ctx.asked).toEqual([SPOTIFY_CLIENT_ID_INPUT]);
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
if (!portFree) console.warn('Skipping the Spotify sign-in tests: port 3010 on 127.0.0.1 is in use on this machine');

// Only bun on PATH: no browser opener can be found, so the address is printed instead.
const terminal = (args: string[]) => spawnCli(['spotify', 'profile', 'add', ...args], { ...vault.env(), PATH: dirname(process.execPath) }, 15_000);

describe('spotify profile add', () => {
  test.skipIf(!portFree)('the Spotify address is printed, nothing is opened, and a denied callback is AUTH_FAILED', async () => {
    const run = terminal(['--client-id', 'abc']);
    const url = new URL((await run.printed(/visit:\n(\S+)/))[1]);
    expect(url.host).toBe('accounts.spotify.com');
    expect(url.searchParams.get('client_id')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3010/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect((await fetch('http://127.0.0.1:3010/callback?error=access_denied')).status).toBe(200);
    const res = await run.finish();
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No browser could be opened on this machine.');
    expect(res.stderr).toMatch(/Error \[AUTH_FAILED\]: .*access_denied/);
  }, 20_000);

  test.skipIf(!portFree)('port 3010 taken: CONFIG_ERROR, and no address is printed to open', async () => {
    const blocker = Bun.serve({ port: 3010, hostname: '127.0.0.1', fetch: () => new Response('busy') });
    try {
      const res = await terminal(['--client-id', 'abc']).finish();
      expect(res.exitCode).toBe(3);
      expect(res.stderr).toContain(`Error [CONFIG_ERROR]: Spotify sign-in needs port 3010 on 127.0.0.1, and another program is using it
Suggestion: Stop the program using 127.0.0.1:3010, then try again`);
      expect(res.stderr).not.toContain('accounts.spotify.com');
    } finally {
      blocker.stop(true);
    }
  }, 20_000);
});
