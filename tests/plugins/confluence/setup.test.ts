import { describe, expect, test } from 'bun:test';
import { dirname } from 'path';
import { confluenceProfileAdd } from '../../../src/plugins/confluence/commands';
import confluencePlugin from '../../../src/plugins/confluence';
import { performConfluenceOAuthFlow } from '../../../src/plugins/confluence/oauth';
import type { OAuthSetupOptions, SetupContext } from '../../../src/plugin-sdk';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { spawnCli } from '../../helpers/cli';

const vault = withTempVault('agentio-confluence-setup-', () => ({ config: { profiles: {} } as never }));
const REDIRECT = 'http://localhost:9999/callback';
const SITES = [
  { id: 'c-1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: [] },
  { id: 'c-2', url: 'https://beta.atlassian.net', name: 'Beta', scopes: [] },
];

type Call = { url: string; init?: RequestInit };

/** A context whose oauth records its options, and whose fetch answers the token exchange and the site list. */
function context(answers: Record<string, string>, sites: unknown = SITES, calls: Call[] = [], seen: OAuthSetupOptions[] = []): SetupContext & { asked: unknown[] } {
  return {
    ...fakeSetupContext(answers),
    async oauth(options) { seen.push(options); return { code: 'c', redirectUri: REDIRECT }; },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify(sites), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

describe('performConfluenceOAuthFlow', () => {
  test('no accessible site is CONFIG_ERROR, not a plain Error', async () => {
    await expect(performConfluenceOAuthFlow(context({}, []))).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: expect.stringContaining('No accessible Confluence sites found'),
    });
  });

  test('a site list the account cannot read fails after the exchange, with nothing asked', async () => {
    const ctx = context({});
    const base = ctx.fetch;
    ctx.fetch = (async (url: string, init?: RequestInit) => String(url).includes('accessible-resources')
      ? new Response('nope', { status: 401 })
      : base(url, init)) as unknown as typeof fetch;
    await expect(performConfluenceOAuthFlow(ctx)).rejects.toThrow('Failed to get accessible resources: nope');
    expect(ctx.asked).toEqual([]);
  });

  test('oauth gets the fixed port and a Confluence authorize URL whose state equals expectedState', async () => {
    const seen: OAuthSetupOptions[] = [];
    await performConfluenceOAuthFlow(context({ 'Confluence site': 'c-1' }, SITES, [], seen));
    expect(seen[0].port).toBe(9999);
    const url = new URL(seen[0].authorizationUrl(REDIRECT));
    expect(url.host).toBe('auth.atlassian.com');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe(seen[0].expectedState!);
    // 128 random bits, as GitHub's flow uses; not Math.random.
    expect(seen[0].expectedState).toMatch(/^[0-9a-f]{32}$/);
    expect(url.searchParams.get('scope')).toContain('read:page:confluence');
  });

  test('the exchange posts the redirect_uri that oauth returned', async () => {
    const calls: Call[] = [];
    await performConfluenceOAuthFlow(context({ 'Confluence site': 'c-1' }, SITES, calls));
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.redirect_uri).toBe(REDIRECT);
    expect(body.code).toBe('c');
  });

  test('several sites with no answer never silently take the first', async () => {
    await expect(performConfluenceOAuthFlow(context({}))).rejects.toThrow('unexpected question: Confluence site');
  });
});

describe('Confluence setup and sign in again', () => {
  test('two sites, answer c-2: the credentials carry that site', async () => {
    const ctx = context({ 'Confluence site': 'c-2' });
    const result = await confluenceProfileAdd({}, ctx);
    expect(result.credentials).toMatchObject({ cloudId: 'c-2', siteUrl: 'https://beta.atlassian.net', accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(result.suggestedProfileName).toBe('beta.atlassian.net');
    expect(ctx.asked).toMatchObject([{ label: 'Confluence site' }]);
  });

  test('an unknown site answer is refused', async () => {
    await expect(confluenceProfileAdd({}, context({ 'Confluence site': 'c-9' }))).rejects.toThrow('Confluence site must be one of: c-1, c-2');
  });

  test('one site: nothing is asked', async () => {
    const ctx = context({}, [SITES[0]]);
    const result = await confluenceProfileAdd({}, ctx);
    expect(result.credentials.cloudId).toBe('c-1');
    expect(ctx.asked).toEqual([]);
  });

  test('reauth does not read the existing refresh token: credentials without it still give a fresh one', async () => {
    const redacted = { accessToken: 'old', cloudId: 'c-1', siteUrl: 'https://acme.atlassian.net', expiryDate: 1 } as never;
    const result = await confluencePlugin.profile!.reauthenticate!(redacted, 'p', context({ 'Confluence site': 'c-2' }));
    expect(result).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', cloudId: 'c-2', siteUrl: 'https://beta.atlassian.net' });
  });

  test('reauth from nothing gives a complete set', async () => {
    const result = await confluencePlugin.profile!.reauthenticate!(null, 'p', context({}, [SITES[0]]));
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.expiryDate).toBeGreaterThan(Date.now());
  });
});

describe('confluence profile add', () => {
  test('prints the Atlassian address with the fixed callback, opens no browser, and a denied callback is AUTH_FAILED', async () => {
    // Only bun on PATH: no browser opener can be found, so the address is printed instead.
    const run = spawnCli(['confluence', 'profile', 'add'], { ...vault.env(), PATH: dirname(process.execPath) });
    const url = new URL((await run.printed(/visit:\n(\S+)/))[1]);
    expect(url.host).toBe('auth.atlassian.com');
    const redirect = url.searchParams.get('redirect_uri')!;
    expect(redirect).toBe('http://localhost:9999/callback');
    expect((await fetch(`${redirect}?error=access_denied`)).status).toBe(200);
    const res = await run.finish();
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No browser could be opened on this machine.');
    expect(res.stderr).toMatch(/Error \[AUTH_FAILED\]: .*access_denied/);
  }, 20_000);
});
