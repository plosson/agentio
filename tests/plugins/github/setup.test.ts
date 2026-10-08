import { afterEach, describe, expect, test } from 'bun:test';
import { dirname } from 'path';
import { githubProfileAdd } from '../../../src/plugins/github/commands';
import githubPlugin from '../../../src/plugins/github';
import { performGitHubOAuthFlow } from '../../../src/plugins/github/oauth';
import type { OAuthSetupOptions, SetupContext } from '../../../src/plugin-sdk';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { spawnCli } from '../../helpers/cli';

const vault = withTempVault('agentio-github-setup-', () => ({ config: { profiles: {} } as never }));
const REDIRECT = 'http://localhost:3001/callback';

type Call = { url: string; init?: RequestInit };

/** A context whose oauth records its options and whose fetch answers the token exchange. */
function context(tokenAnswer: unknown, calls: Call[] = [], seen: OAuthSetupOptions[] = []): SetupContext {
  return {
    ...fakeSetupContext({}),
    async oauth(options) { seen.push(options); return { code: 'c', redirectUri: REDIRECT }; },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(tokenAnswer), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubUser(user: { login: string; email: string | null }): void {
  globalThis.fetch = (async (url: string) => {
    expect(String(url)).toBe('https://api.github.com/user');
    return new Response(JSON.stringify(user), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('performGitHubOAuthFlow', () => {
  test('GitHub refusing the code is AUTH_FAILED with its own message', async () => {
    const ctx = context({ error: 'bad_verification_code', error_description: 'The code passed is incorrect' });
    await expect(performGitHubOAuthFlow(ctx)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: 'The code passed is incorrect',
      suggestion: 'Try again: agentio github profile add',
    });
  });

  test('an error without description falls back to the error, and an empty answer to a fixed message', async () => {
    await expect(performGitHubOAuthFlow(context({ error: 'bad_verification_code' }))).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'bad_verification_code' });
    await expect(performGitHubOAuthFlow(context({}))).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'Failed to get access token' });
  });

  test('the authorize URL carries the scope and a random 32-hex state equal to expectedState', async () => {
    const seen: OAuthSetupOptions[] = [];
    await performGitHubOAuthFlow(context({ access_token: 't' }, [], seen));
    const url = new URL(seen[0].authorizationUrl(REDIRECT));
    expect(url.host).toBe('github.com');
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe(seen[0].expectedState!);
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  test('the token exchange posts the redirect_uri that oauth returned, through context.fetch', async () => {
    const calls: Call[] = [];
    const result = await performGitHubOAuthFlow(context({ access_token: 'new' }, calls));
    expect(result.accessToken).toBe('new');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://github.com/login/oauth/access_token');
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.redirect_uri).toBe(REDIRECT);
    expect(body.code).toBe('c');
  });
});

describe('GitHub setup and sign in again', () => {
  test('setup returns the new token and the user', async () => {
    stubUser({ login: 'octo', email: 'o@x.io' });
    const result = await githubProfileAdd({}, context({ access_token: 'new' }));
    expect(result.credentials).toEqual({ accessToken: 'new', username: 'octo', email: 'o@x.io' });
    expect(result.suggestedProfileName).toBe('octo');
  });

  test('reauth does not read the existing token: credentials without it still give a fresh one', async () => {
    stubUser({ login: 'octo', email: null });
    const redacted = { username: 'x', email: null } as never;
    const result = await githubPlugin.profile!.reauthenticate!(redacted, 'p', context({ access_token: 'new' }));
    expect(result).toEqual({ accessToken: 'new', username: 'octo', email: null });
  });

  test('reauth replaces an old token and the user', async () => {
    stubUser({ login: 'octo', email: null });
    const result = await githubPlugin.profile!.reauthenticate!({ accessToken: 'old', username: 'x', email: null }, 'p', context({ access_token: 'new' }));
    expect(result).toEqual({ accessToken: 'new', username: 'octo', email: null });
  });

  test('a refused code stops before any user lookup', async () => {
    globalThis.fetch = (async () => { throw new Error('GitHub API must not be called'); }) as unknown as typeof fetch;
    await expect(githubPlugin.profile!.reauthenticate!(null, 'p', context({ error: 'bad_verification_code' }))).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});

describe('github profile add', () => {
  test('prints the GitHub address, opens no browser, and a denied callback is AUTH_FAILED', async () => {
    // Only bun on PATH: no browser opener can be found, so the address is printed instead.
    const run = spawnCli(['github', 'profile', 'add'], { ...vault.env(), PATH: dirname(process.execPath) });
    const url = new URL((await run.printed(/visit:\n(\S+)/))[1]);
    expect(url.host).toBe('github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    const redirect = url.searchParams.get('redirect_uri')!;
    expect((await fetch(`${redirect}?error=access_denied`)).status).toBe(200);
    const res = await run.finish();
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No browser could be opened on this machine.');
    expect(res.stderr).toMatch(/Error \[AUTH_FAILED\]: .*access_denied/);
  }, 20_000);
});
