import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { confluenceProfileAdd } from '../../../src/plugins/confluence/commands';
import confluencePlugin from '../../../src/plugins/confluence';
import { performConfluenceOAuthFlow } from '../../../src/plugins/confluence/oauth';
import type { OAuthSetupOptions, SetupContext } from '../../../src/plugin-sdk';
import { fakeSetupContext } from '../../helpers/setup-context';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';

const vault = withTempVault('agentio-confluence-json-', () => ({ config: { profiles: {} } as never }));
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
    await performConfluenceOAuthFlow(context({ site: 'c-1' }, SITES, [], seen));
    expect(seen[0].port).toBe(9999);
    const url = new URL(seen[0].authorizationUrl(REDIRECT));
    expect(url.host).toBe('auth.atlassian.com');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe(seen[0].expectedState!);
    expect(url.searchParams.get('scope')).toContain('read:page:confluence');
  });

  test('the exchange posts the redirect_uri that oauth returned', async () => {
    const calls: Call[] = [];
    await performConfluenceOAuthFlow(context({ site: 'c-1' }, SITES, calls));
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.redirect_uri).toBe(REDIRECT);
    expect(body.code).toBe('c');
  });

  test('several sites with no answer never silently take the first', async () => {
    await expect(performConfluenceOAuthFlow(context({}))).rejects.toThrow('unexpected question: site');
  });
});

describe('Confluence setup and sign in again', () => {
  test('two sites, answer c-2: the credentials carry that site', async () => {
    const ctx = context({ site: 'c-2' });
    const result = await confluenceProfileAdd({}, ctx);
    expect(result.credentials).toMatchObject({ cloudId: 'c-2', siteUrl: 'https://beta.atlassian.net', accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(result.suggestedProfileName).toBe('beta.atlassian.net');
    expect(ctx.asked).toMatchObject([{ id: 'site', label: 'Confluence site' }]);
  });

  test('an unknown site answer is refused', async () => {
    await expect(confluenceProfileAdd({}, context({ site: 'c-9' }))).rejects.toThrow('Confluence site must be one of: c-1, c-2');
  });

  test('one site: nothing is asked', async () => {
    const ctx = context({}, [SITES[0]]);
    const result = await confluenceProfileAdd({}, ctx);
    expect(result.credentials.cloudId).toBe('c-1');
    expect(ctx.asked).toEqual([]);
  });

  test('reauth does not read the existing refresh token: credentials without it still give a fresh one', async () => {
    const redacted = { accessToken: 'old', cloudId: 'c-1', siteUrl: 'https://acme.atlassian.net', expiryDate: 1 } as never;
    const result = await confluencePlugin.profile!.reauthenticate!(redacted, 'p', context({ site: 'c-2' }));
    expect(result).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', cloudId: 'c-2', siteUrl: 'https://beta.atlassian.net' });
  });

  test('reauth from nothing gives a complete set', async () => {
    const result = await confluencePlugin.profile!.reauthenticate!(null, 'p', context({}, [SITES[0]]));
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.expiryDate).toBeGreaterThan(Date.now());
  });
});

describe('confluence profile add --json', () => {
  test('--describe --json: a browser sign-in and no input, the site is asked at run time', async () => {
    const res = await runCli(['confluence', 'profile', 'add', '--describe', '--json'], vault.env());
    expect(res.exitCode).toBe(0);
    expect(res.events).toEqual([{ v: 1, event: 'needs', service: 'confluence', inputs: [], auth: 'browser' }]);
  }, 20_000);

  test('the run-time site id is not an input: --input with it is refused as unknown', async () => {
    const res = await runCli(['confluence', 'profile', 'add', '--json', '--input', '-'], vault.env(), ['{"site":"c-2"}']);
    expect(res.exitCode).not.toBe(0);
    expect(res.events.map((e) => e.event)).toEqual(['error']);
    expect(res.events[0]).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(res.events[0].message).toContain('Unknown setup value "site"');
  }, 20_000);

  test('--json prints the Atlassian address with the fixed callback, opens no browser, and a denied callback is AUTH_FAILED', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'agentio-bin-'));
    const mark = join(bin, 'opened');
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(bin, name), `#!/bin/sh\necho "$@" > "${mark}"\n`);
      await chmod(join(bin, name), 0o755);
    }
    const env = { ...vault.env(), PATH: `${bin}:${process.env.PATH}` };
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', 'confluence', 'profile', 'add', '--json'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const event = JSON.parse(new TextDecoder().decode(value).split('\n')[0]);
    expect(event.event).toBe('open');
    const url = new URL(event.url);
    expect(url.host).toBe('auth.atlassian.com');
    const redirect = url.searchParams.get('redirect_uri')!;
    expect(redirect).toBe('http://localhost:9999/callback');
    const res = await fetch(`${redirect}?error=access_denied`);
    expect(res.status).toBe(200);
    expect(await proc.exited).toBe(2);
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    const error = rest.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'error');
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('access_denied');
    expect(existsSync(mark)).toBe(false);
  }, 20_000);
});
