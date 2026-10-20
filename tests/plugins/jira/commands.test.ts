import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { runCli } from '../../helpers/cli';
import { exitCodeForError } from '../../../src/utils/errors';
import { parseFields, parseLimit } from '../../../src/plugins/jira/commands';

/**
 * The CLI as an agent runs it, in its own process. The preload answers the Jira API of a fake
 * cloud id and refuses every other address, so nothing here reaches a real Jira.
 */

let vault: ReturnType<typeof withTempVault>;
const own = withTempVault('agentio-jira-cli-', () => ({
  config: { profiles: { jira: [{ name: 'main' }] } } as never,
  credentials: {
    jira: { main: { accessToken: 'token', refreshToken: 'refresh', expiryDate: Date.now() + 3_600_000, cloudId: 'cloud-test', siteUrl: 'https://example.atlassian.net' } },
  } as never,
}));
beforeEach(() => { vault = own; });

const log = () => join(vault.home(), 'requests.log');
const requests = () => (existsSync(log()) ? readFileSync(log(), 'utf8').trim().split('\n').map((u) => new URL(u)) : []);
const cli = (args: string[], total = 0) => runCli(['jira', ...args], {
  ...vault.env(),
  BUN_OPTIONS: `--preload=${join(import.meta.dir, 'stub-api-preload.ts')}`,
  STUB_JIRA_TOTAL: String(total),
  STUB_JIRA_LOG: log(),
});

const INVALID = exitCodeForError('INVALID_PARAMS');

describe('jira search', () => {
  test('--limit 1000 pages past 100 and returns 1000, says it is truncated, and --json is clean', async () => {
    const res = await cli(['search', '--jql', 'updated >= 2026-07-01', '--limit', '1000', '--json', '--profile', 'main'], 1500);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.count).toBe(1000);
    expect(out.issues).toHaveLength(1000);
    expect(out.truncated).toBe(true);
    expect(out.nextPageToken).toBe('1000');
    expect(out.issues[0]).toMatchObject({ key: 'PROJ-1', assignee: { accountId: 'acc-1' }, created: expect.any(String), resolutionDate: expect.any(String) });
    expect(res.stderr).toContain('more issues match');
    expect(res.stderr).toContain('--page-token 1000');
    expect(requests()).toHaveLength(10);
  }, 60_000);

  test('--limit 20000 never sends more than 5000 per page and gets every match', async () => {
    const res = await cli(['search', '--jql', 'project = PROJ', '--limit', '20000', '--json'], 250);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect([out.count, out.truncated]).toEqual([250, false]);
    expect(requests().every((u) => Number(u.searchParams.get('maxResults')) <= 5000)).toBe(true);
    expect(res.stderr).not.toContain('more issues match');
  }, 60_000);

  test('--page-token resumes, --limit all reads to the end', async () => {
    const res = await cli(['search', '--jql', 'project = PROJ', '--limit', 'all', '--page-token', '200', '--json'], 450);
    const out = JSON.parse(res.stdout);
    expect(out.count).toBe(250);
    expect(out.issues[0].key).toBe('PROJ-201');
  }, 60_000);

  test('text output shows created, resolved and account ids', async () => {
    const res = await cli(['search', '--limit', '2'], 2);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Assignee: Alice (acc-1)');
    expect(res.stdout).toContain('Created: 2026-07-01T10:00:00.000+0000');
    expect(res.stdout).toContain('Resolved: 2026-07-03T10:00:00.000+0000 (Fixed)');
  }, 60_000);

  test('a bad --limit is refused before any request', async () => {
    for (const limit of ['0', '-5', 'abc', '1.5']) {
      const res = await cli(['search', '--limit', limit], 10);
      expect(res.exitCode).toBe(INVALID);
      expect(res.stderr).toContain('--limit');
    }
    expect(requests()).toHaveLength(0);
  }, 60_000);
});

describe('jira get', () => {
  test('--changelog --json carries parent, fix versions, accountIds and the status history', async () => {
    const res = await cli(['get', 'PROJ-7', '--changelog', '--json', '--profile', 'main']);
    expect(res.exitCode).toBe(0);
    const issue = JSON.parse(res.stdout);
    expect(issue).toMatchObject({
      key: 'PROJ-7',
      parent: { key: 'PROJ-1', issueType: 'Epic' },
      fixVersions: ['1.0'],
      labels: ['x'],
      resolutionDate: '2026-07-03T10:00:00.000+0000',
      reporter: { accountId: 'acc-rep' },
    });
    expect(issue.changelog[0].items[0]).toMatchObject({ fieldId: 'status', fromString: 'To Do', toString: 'In Progress' });
  }, 60_000);

  test('text output prints the changelog', async () => {
    const res = await cli(['get', 'PROJ-7', '--changelog']);
    expect(res.stdout).toContain('Parent: PROJ-1 (Epic: Epic)');
    expect(res.stdout).toContain('status: To Do → In Progress');
  }, 60_000);
});

describe('jira users search', () => {
  test('returns the accountId for an email, options on the subcommand are read', async () => {
    const res = await cli(['users', 'search', 'alice@example.com', '--limit', '5', '--json', '--profile', 'main']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ users: [{ accountId: 'acc-alice', displayName: 'Alice', emailAddress: 'alice@example.com', active: true, accountType: 'atlassian' }] });
    const [req] = requests();
    expect(req.searchParams.get('query')).toBe('alice@example.com');
    expect(req.searchParams.get('maxResults')).toBe('5');
  }, 60_000);

  test('an unknown profile is refused', async () => {
    const res = await cli(['users', 'search', 'alice', '--profile', 'other']);
    expect(res.exitCode).toBe(exitCodeForError('PROFILE_NOT_FOUND'));
  }, 60_000);
});

describe('option parsing helpers', () => {
  test('parseLimit', () => {
    expect(parseLimit('50')).toBe(50);
    expect(parseLimit('ALL')).toBe(Number.POSITIVE_INFINITY);
    expect(() => parseLimit('0')).toThrow();
  });
  test('parseFields', () => {
    expect(parseFields(undefined)).toBeUndefined();
    expect(parseFields('customfield_1, duedate')).toEqual(['customfield_1', 'duedate']);
    expect(() => parseFields(' , ')).toThrow();
  });
});
