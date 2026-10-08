import { expect, test } from 'bun:test';
import { getAccessibleResources, selectAtlassianSite } from '../../../src/plugins/atlassian/sites';
import { fakeSetupContext } from '../../helpers/setup-context';
import { CliError } from '../../../src/utils/errors';

const sites = [
  { id: 'c-1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: [] },
  { id: 'c-2', url: 'https://beta.atlassian.net', name: 'Beta', scopes: [] },
];
const CHOICES = [{ value: 'c-1', label: 'Acme (https://acme.atlassian.net)' }, { value: 'c-2', label: 'Beta (https://beta.atlassian.net)' }];

test('several sites: one question, a choice by site id, labelled with name and address', async () => {
  const ctx = fakeSetupContext({ 'Jira site': 'c-2' });
  expect(await selectAtlassianSite(sites, ctx, 'Jira')).toBe(sites[1]);
  expect(ctx.asked).toEqual([{ label: 'Jira site', kind: 'choice', choices: CHOICES }]);
});

test('the question names the product it is asked for', async () => {
  const ctx = fakeSetupContext({ 'Confluence site': 'c-1' });
  expect(await selectAtlassianSite(sites, ctx, 'Confluence')).toBe(sites[0]);
  expect(ctx.asked).toEqual([{ label: 'Confluence site', kind: 'choice', choices: CHOICES }]);
});

for (const product of ['Jira', 'Confluence'] as const) {
  test(`no site at all (${product}): CONFIG_ERROR naming ${product}, with a suggestion, nothing asked`, async () => {
    const ctx = fakeSetupContext({ [`${product} site`]: 'c-1' });
    const err = await selectAtlassianSite([], ctx, product).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: 'CONFIG_ERROR', message: expect.stringContaining(`No accessible ${product} sites found`) });
    expect((err as CliError).suggestion).toBeTruthy();
    expect(ctx.asked).toEqual([]);
  });
}

test('one site: nothing is asked', async () => {
  const ctx = fakeSetupContext({});
  expect(await selectAtlassianSite([sites[0]], ctx, 'Confluence')).toBe(sites[0]);
  expect(ctx.asked).toEqual([]);
});

test('an answer that is not one of the sites is refused', async () => {
  const err = await selectAtlassianSite(sites, fakeSetupContext({ 'Jira site': 'c-9' }), 'Jira').catch((e: unknown) => e);
  expect(String(err)).toContain('Jira site must be one of: c-1, c-2');
  const err2 = await selectAtlassianSite(sites, fakeSetupContext({ 'Confluence site': 'c-9' }), 'Confluence').catch((e: unknown) => e);
  expect(String(err2)).toContain('Confluence site must be one of: c-1, c-2');
});

test('getAccessibleResources sends the bearer token and returns the sites', async () => {
  let seen: { url: string; auth: string | null } | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen = { url: String(url), auth: new Headers(init?.headers).get('Authorization') };
    return new Response(JSON.stringify(sites), { status: 200 });
  }) as unknown as typeof fetch;
  expect(await getAccessibleResources('tok', fetchImpl)).toEqual(sites);
  expect(seen).toEqual({ url: 'https://api.atlassian.com/oauth/token/accessible-resources', auth: 'Bearer tok' });
});

test('getAccessibleResources: a refused token fails with Atlassian\'s answer', async () => {
  const fetchImpl = (async () => new Response('token expired', { status: 401 })) as unknown as typeof fetch;
  await expect(getAccessibleResources('bad', fetchImpl)).rejects.toThrow('Failed to get accessible resources: token expired');
});
