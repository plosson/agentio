// Preloaded into a CLI subprocess (BUN_OPTIONS=--preload): the Jira REST API of the fake cloud id
// `cloud-test` is answered here, so a test never reaches any real Jira. Search serves STUB_JIRA_TOTAL
// issues, at most 100 per page, as /search/jql does; every request URL is appended to STUB_JIRA_LOG.
import { appendFileSync } from 'fs';

const BASE = 'https://api.atlassian.com/ex/jira/cloud-test/rest/api/3';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function issue(n: number) {
  return {
    id: String(n),
    key: `PROJ-${n}`,
    fields: {
      summary: `Issue ${n}`,
      status: { name: 'Done', statusCategory: { key: 'done' } },
      assignee: { accountId: `acc-${n}`, displayName: 'Alice' },
      reporter: { accountId: 'acc-rep', displayName: 'Bob' },
      created: '2026-07-01T10:00:00.000+0000',
      updated: '2026-07-02T10:00:00.000+0000',
      resolution: { name: 'Fixed' },
      resolutiondate: '2026-07-03T10:00:00.000+0000',
      project: { key: 'PROJ' },
      issuetype: { name: 'Story' },
      parent: { id: '1', key: 'PROJ-1', fields: { summary: 'Epic', issuetype: { name: 'Epic' } } },
      labels: ['x'],
      components: [],
      fixVersions: [{ name: '1.0' }],
    },
  };
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (!url.href.startsWith(`${BASE}/`)) throw new TypeError(`blocked: ${url.href}`);
  if (process.env.STUB_JIRA_LOG) appendFileSync(process.env.STUB_JIRA_LOG, url.href + '\n');
  const path = url.pathname.slice(new URL(BASE).pathname.length);
  const q = url.searchParams;

  if (path === '/search/jql') {
    const max = Number(q.get('maxResults'));
    if (!(max >= 1 && max <= 5000)) return json({ errorMessages: ['The max results parameter has to be between 1 and 5,000.'] }, 400);
    const total = Number(process.env.STUB_JIRA_TOTAL ?? '0');
    const start = Number(q.get('nextPageToken') ?? '0');
    const end = Math.min(start + Math.min(max, 100), total);
    const issues = Array.from({ length: Math.max(end - start, 0) }, (_, i) => issue(start + i + 1));
    return json(end < total ? { issues, nextPageToken: String(end), isLast: false } : { issues, isLast: true });
  }
  if (path === '/issue/PROJ-7') return json(issue(7));
  if (path === '/issue/PROJ-7/changelog') {
    return json({
      values: [{ id: '1', created: '2026-07-02T09:00:00.000+0000', author: { accountId: 'acc-7', displayName: 'Alice' },
        items: [{ field: 'status', fieldId: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }] }],
      startAt: Number(q.get('startAt')), total: 1, isLast: true,
    });
  }
  if (path === '/user/search') {
    return json([{ accountId: 'acc-alice', displayName: 'Alice', emailAddress: q.get('query'), active: true, accountType: 'atlassian' }]);
  }
  return json({ errorMessages: [`no stub for ${path}`] }, 404);
}) as typeof fetch;
