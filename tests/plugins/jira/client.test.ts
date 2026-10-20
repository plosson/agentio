import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { JiraClient, SEARCH_PAGE_MAX } from '../../../src/plugins/jira/client';
import type { JiraCredentials } from '../../../src/plugins/jira/types';
import { FakeFetch, caught } from '../../helpers/fake-fetch';

const CREDENTIALS: JiraCredentials = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiryDate: Date.now() + 3_600_000,
  cloudId: 'cloud-test',
  siteUrl: 'https://example.atlassian.net',
};
const BASE = 'https://api.atlassian.com/ex/jira/cloud-test/rest/api/3';

let fake: FakeFetch;
const waits: number[] = [];
beforeEach(() => { fake = new FakeFetch(); waits.length = 0; });
afterEach(() => fake.restore());

const client = () => new JiraClient(CREDENTIALS, { wait: async (ms) => { waits.push(ms); } });
const params = (i: number) => new URL(fake.log[i].url).searchParams;

function rawIssue(n: number, fields: Record<string, unknown> = {}) {
  return {
    id: String(10000 + n),
    key: `PROJ-${n}`,
    fields: {
      summary: `Issue ${n}`,
      status: { name: 'Done', statusCategory: { key: 'done' } },
      assignee: { accountId: `acc-${n}`, displayName: 'Alice', emailAddress: 'alice@example.com', active: true },
      reporter: { accountId: 'acc-rep', displayName: 'Bob' },
      created: '2026-07-01T10:00:00.000+0000',
      updated: '2026-07-02T10:00:00.000+0000',
      resolution: { name: 'Fixed' },
      resolutiondate: '2026-07-03T10:00:00.000+0000',
      project: { key: 'PROJ' },
      issuetype: { name: 'Story' },
      parent: { id: '9', key: 'PROJ-1', fields: { summary: 'The epic', issuetype: { name: 'Epic' } } },
      labels: ['backend'],
      components: [{ name: 'API' }],
      fixVersions: [{ name: '1.2' }],
      ...fields,
    },
  };
}
const page = (from: number, count: number, next?: string) => ({
  issues: Array.from({ length: count }, (_, i) => rawIssue(from + i)),
  ...(next ? { nextPageToken: next } : {}),
  isLast: !next,
});

describe('searchIssues pagination', () => {
  test('follows nextPageToken until the limit and reports the rest as truncated', async () => {
    fake.answer({ status: 200, body: page(1, 100, 't2') })
      .answer({ status: 200, body: page(101, 100, 't3') })
      .answer({ status: 200, body: page(201, 50, 't4') });
    const result = await client().searchIssues({ jql: 'updated >= 2026-07-01', maxResults: 250 });

    expect(result.issues).toHaveLength(250);
    expect(result.truncated).toBe(true);
    expect(result.nextPageToken).toBe('t4');
    expect(fake.log.map((r) => new URL(r.url).pathname)).toEqual(Array(3).fill('/ex/jira/cloud-test/rest/api/3/search/jql'));
    expect([0, 1, 2].map((i) => params(i).get('maxResults'))).toEqual(['250', '150', '50']);
    expect([0, 1, 2].map((i) => params(i).get('nextPageToken'))).toEqual([null, 't2', 't3']);
    expect(params(0).get('jql')).toBe('updated >= 2026-07-01');
  });

  test('a limit above the API maximum never sends more than it per page, and stops on the last page', async () => {
    fake.answer({ status: 200, body: page(1, 100, 't2') })
      .answer({ status: 200, body: page(101, 30) });
    const result = await client().searchIssues({ maxResults: 20000 });
    expect(result.issues).toHaveLength(130);
    expect(result.truncated).toBe(false);
    expect(result.nextPageToken).toBeUndefined();
    expect(params(0).get('maxResults')).toBe(String(SEARCH_PAGE_MAX));
    expect(fake.log).toHaveLength(2);
  });

  test('limit all (Infinity) reads every page', async () => {
    fake.answer({ status: 200, body: page(1, 100, 'a') })
      .answer({ status: 200, body: page(101, 100, 'b') })
      .answer({ status: 200, body: page(201, 1) });
    const result = await client().searchIssues({ maxResults: Number.POSITIVE_INFINITY });
    expect(result.issues).toHaveLength(201);
    expect(result.truncated).toBe(false);
  });

  test('exactly the limit with nothing left is not truncated', async () => {
    fake.answer({ status: 200, body: page(1, 10) });
    const result = await client().searchIssues({ maxResults: 10 });
    expect(result).toMatchObject({ truncated: false });
    expect(fake.log).toHaveLength(1);
  });

  test('a page token resumes an earlier search', async () => {
    fake.answer({ status: 200, body: page(51, 5) });
    await client().searchIssues({ jql: 'project = PROJ', nextPageToken: 'resume-me', maxResults: 50 });
    expect(params(0).get('nextPageToken')).toBe('resume-me');
  });

  test('an empty page ends the loop even when a token comes back', async () => {
    fake.answer({ status: 200, body: { issues: [], nextPageToken: 'x', isLast: false } });
    const result = await client().searchIssues({ maxResults: 100 });
    expect(result.issues).toHaveLength(0);
    expect(fake.log).toHaveLength(1);
  });
});

describe('issue fields', () => {
  test('search maps accountIds, dates, parent, labels, components, fix versions and extra fields', async () => {
    fake.answer({ status: 200, body: page(2, 1) });
    fake.log.length = 0;
    const result = await client().searchIssues({ maxResults: 1, fields: ['customfield_10016'] });
    const fields = params(0).get('fields')!.split(',');
    expect(fields).toEqual(expect.arrayContaining(['created', 'resolutiondate', 'resolution', 'parent', 'labels', 'components', 'fixVersions', 'customfield_10016']));
    expect(result.issues[0]).toMatchObject({
      key: 'PROJ-2',
      assignee: { accountId: 'acc-2', displayName: 'Alice', emailAddress: 'alice@example.com', active: true },
      reporter: { accountId: 'acc-rep', displayName: 'Bob' },
      created: '2026-07-01T10:00:00.000+0000',
      resolution: 'Fixed',
      resolutionDate: '2026-07-03T10:00:00.000+0000',
      parent: { key: 'PROJ-1', summary: 'The epic', issueType: 'Epic' },
      labels: ['backend'],
      components: ['API'],
      fixVersions: ['1.2'],
      extraFields: { customfield_10016: null },
    });
  });

  test('unassigned and unresolved issues have no assignee or resolution', async () => {
    fake.answer({ status: 200, body: { issues: [rawIssue(3, { assignee: null, resolution: null, resolutiondate: null, parent: undefined, labels: undefined })], isLast: true } });
    const [issue] = (await client().searchIssues({})).issues;
    expect(issue.assignee).toBeUndefined();
    expect(issue.resolution).toBeUndefined();
    expect(issue.resolutionDate).toBeUndefined();
    expect(issue.parent).toBeUndefined();
    expect(issue.labels).toEqual([]);
  });

  test('get with --changelog reads every changelog page, and --comments every comment page', async () => {
    const entry = (id: number) => ({
      id: String(id),
      created: `2026-07-0${id}T09:00:00.000+0000`,
      author: { accountId: 'acc-1', displayName: 'Alice' },
      items: [{ field: 'status', fieldId: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }],
    });
    fake.answer({ status: 200, body: rawIssue(7, { customfield_1: 5 }) })
      .answer({ status: 200, body: { comments: [{ id: 'c1', author: { accountId: 'acc-9', displayName: 'Zoe' }, body: null, created: 'x', updated: 'x' }], total: 1 } })
      .answer({ status: 200, body: { values: Array.from({ length: 100 }, (_, i) => entry(1 + (i % 8))), startAt: 0, total: 102, isLast: false } })
      .answer({ status: 200, body: { values: [entry(1), entry(2)], startAt: 100, total: 102, isLast: true } });

    const issue = await client().getIssue('PROJ-7', { changelog: true, comments: true, fields: ['customfield_1'] });
    expect(issue.extraFields).toEqual({ customfield_1: 5 });
    expect(issue.comments).toEqual([{ id: 'c1', author: 'Zoe', authorAccountId: 'acc-9', body: '', created: 'x', updated: 'x' }]);
    expect(issue.changelog).toHaveLength(102);
    expect(issue.changelog![0]).toEqual({
      id: '1',
      created: '2026-07-01T09:00:00.000+0000',
      author: { accountId: 'acc-1', displayName: 'Alice' },
      items: [{ field: 'status', fieldId: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }],
    });
    expect(new URL(fake.log[0].url).searchParams.get('fields')).toContain('customfield_1');
    expect(new URL(fake.log[2].url).pathname).toEndWith('/issue/PROJ-7/changelog');
    expect([2, 3].map((i) => params(i).get('startAt'))).toEqual(['0', '100']);
  });

  test('get without flags makes one request', async () => {
    fake.answer({ status: 200, body: rawIssue(8) });
    const issue = await client().getIssue('PROJ-8');
    expect(issue.changelog).toBeUndefined();
    expect(issue.comments).toBeUndefined();
    expect(fake.log).toHaveLength(1);
  });
});

describe('users', () => {
  test('search returns accountId, name, email and active, and asks for the limit', async () => {
    fake.answer({ status: 200, body: [
      { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com', active: true, accountType: 'atlassian' },
      { accountId: 'a2', displayName: 'Alicia', active: false },
    ] });
    const users = await client().searchUsers('ali', { maxResults: 10 });
    expect(users).toEqual([
      { accountId: 'a1', displayName: 'Alice', emailAddress: 'alice@example.com', active: true, accountType: 'atlassian' },
      { accountId: 'a2', displayName: 'Alicia', active: false },
    ]);
    expect(fake.log[0].url).toStartWith(`${BASE}/user/search?`);
    expect(params(0).get('query')).toBe('ali');
    expect(params(0).get('maxResults')).toBe('10');
  });

  test('a missing scope explains what is needed instead of a bare API error', async () => {
    fake.answer({ status: 401, body: { code: 401, message: 'Unauthorized; scope does not match' } });
    const error = await caught(client().searchUsers('alice@example.com'));
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.suggestion).toContain('read:jira-user');
  });

  test('get looks a user up by accountId', async () => {
    fake.answer({ status: 200, body: { accountId: 'a1', displayName: 'Alice', active: true } });
    expect(await client().getUser('a1')).toEqual({ accountId: 'a1', displayName: 'Alice', active: true });
    expect(params(0).get('accountId')).toBe('a1');
  });
});

describe('rate limits', () => {
  test('429 is retried after Retry-After, so a backfill survives it', async () => {
    fake.answer({ status: 429, body: { message: 'slow down' } }).answer({ status: 200, body: page(1, 1) });
    const result = await client().searchIssues({ maxResults: 1 });
    expect(result.issues).toHaveLength(1);
    expect(fake.log).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  test('a rate limit that never lifts ends in RATE_LIMITED after the retries', async () => {
    for (let i = 0; i < 5; i++) fake.answer({ status: 429, body: { message: 'slow down' } });
    const error = await caught(client().searchIssues({ maxResults: 1 }));
    expect(error.code).toBe('RATE_LIMITED');
    expect(fake.log).toHaveLength(5);
  });
});
