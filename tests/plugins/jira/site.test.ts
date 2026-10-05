import { expect, test } from 'bun:test';
import { selectJiraSite } from '../../../src/plugins/jira/oauth';
import { fakeSetupContext } from '../../helpers/setup-context';

const sites = [
  { id: 'c-1', url: 'https://acme.atlassian.net', name: 'Acme', scopes: [] },
  { id: 'c-2', url: 'https://beta.atlassian.net', name: 'Beta', scopes: [] },
];

test('several sites: one question, a choice by site id, labelled with name and address', async () => {
  const ctx = fakeSetupContext({ site: 'c-2' });
  expect(await selectJiraSite(sites, ctx)).toBe(sites[1]);
  expect(ctx.asked).toEqual([{
    id: 'site', label: 'Jira site', kind: 'choice',
    choices: [{ value: 'c-1', label: 'Acme (https://acme.atlassian.net)' }, { value: 'c-2', label: 'Beta (https://beta.atlassian.net)' }],
  }]);
});

test('one site: nothing is asked', async () => {
  const ctx = fakeSetupContext({});
  expect(await selectJiraSite([sites[0]], ctx)).toBe(sites[0]);
  expect(ctx.asked).toEqual([]);
});

test('an answer that is not one of the sites is refused', async () => {
  const err = await selectJiraSite(sites, fakeSetupContext({ site: 'c-9' })).catch((e) => e);
  expect(String(err)).toContain('Jira site must be one of: c-1, c-2');
});
