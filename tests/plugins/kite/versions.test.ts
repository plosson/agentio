import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { KiteClient, parseVersion } from '../../../src/plugins/kite/client';
import { FakeKite, caught } from './fake-kite';

const ME = 'me@example.com';
let fake: FakeKite;
let token: string;
let client: KiteClient;

beforeEach(() => {
  fake = new FakeKite();
  token = fake.issueToken(ME);
  client = new KiteClient({ baseUrl: fake.url, token });
});

afterEach(() => fake.stop());

/** Nothing a user sees names the server's word for a document, or the token. */
function clean(text: string) {
  expect(text).not.toContain(token);
  expect(text.toLowerCase()).not.toContain('artifact');
}

describe('parseVersion', () => {
  test('takes a whole number from 1 up', () => {
    expect(parseVersion('3')).toBe(3);
    expect(parseVersion(' 12 ')).toBe(12);
    expect(parseVersion(1)).toBe(1);
  });

  test('refuses anything else before a request', () => {
    for (const bad of ['0', '-1', '1.5', 'two', '', '1e3', '99999999999999999999']) {
      expect(() => parseVersion(bad)).toThrow('Not a version number');
    }
  });
});

describe('versions', () => {
  test('lists every version newest first, with views per version and no content', async () => {
    const doc = fake.seedDoc(ME, { content: '# One', title: 'Plan' });
    fake.seedEdit(doc, '# Two, longer', 'Plan v2');
    fake.seedOpen(doc, ME, 1);
    fake.seedOpen(doc, 'p@x.com', 2);
    fake.seedOpen(doc, ME, 2);
    fake.seedOpen(doc, ME, 2, 'api');

    const list = await client.versions(doc.id);
    expect(list).toEqual({
      id: doc.id,
      url: `${fake.url}/a/${doc.slug}`,
      currentVersion: 2,
      retentionDays: 180,
      versions: [
        { version: 2, kind: 'edited', title: 'Plan v2', type: 'markdown', bytes: 13, created: doc.history[1].createdAt, current: true, views: 2, ownerViews: 1, otherViews: 1 },
        { version: 1, kind: 'published', title: 'Plan', type: 'markdown', bytes: 5, created: doc.history[0].createdAt, current: false, views: 1, ownerViews: 1, otherViews: 0 },
      ],
    });
    clean(JSON.stringify(list));
  });

  test('a link is looked up to its id first', async () => {
    const doc = fake.seedDoc(ME);
    const list = await client.versions(`${fake.url}/a/${doc.slug}`);
    expect(list.id).toBe(doc.id);
    expect(fake.requests('GET').map((r) => r.path)).toEqual([`/api/artifacts/by-slug/${doc.slug}`, `/api/artifacts/${doc.id}/versions`]);
  });

  test('somebody else\'s document is not found', async () => {
    const theirs = fake.seedDoc('other@example.com');
    const e = await caught(client.versions(theirs.id));
    expect(e.code).toBe('NOT_FOUND');
    clean(`${e.message} ${e.suggestion}`);
  });

  test('a server without version history says so and names the Kite version it needs', async () => {
    fake.versionsApi = false;
    const doc = fake.seedDoc(ME);
    for (const p of [client.versions(doc.id), client.getVersion(doc.id, 1)]) {
      const e = await caught(p);
      expect(e.code).toBe('API_ERROR');
      expect(e.message).toBe(`Kite at ${fake.url} does not have version history yet`);
      expect(e.suggestion).toContain('Kite 1.3.0 or later');
      clean(`${e.message} ${e.suggestion}`);
    }
  });

  test('a proxy page in place of the route is the same message, never a crash', async () => {
    const doc = fake.seedDoc(ME);
    fake.failNextText(404, '<html>Not Found</html>');
    expect((await caught(client.versions(doc.id))).message).toContain('does not have version history yet');
    fake.failNextText(200, '<html>app shell</html>');
    expect((await caught(client.versions(doc.id))).message).toContain('does not have version history yet');
  });
});

describe('getVersion', () => {
  test('returns the version as it was, shaped like a document', async () => {
    const doc = fake.seedDoc(ME, { content: '# One', title: 'Plan' });
    fake.seedEdit(doc, '# Two', 'Plan v2');
    const old = await client.getVersion(doc.id, '1');
    expect(old).toMatchObject({ id: doc.id, title: 'Plan', content: '# One', version: 1, currentVersion: 2, current: false });
    expect(old.updated).toBe(doc.history[0].createdAt);
    const now = await client.getVersion(doc.id, 2);
    expect(now).toMatchObject({ content: '# Two', version: 2, current: true });
  });

  test('is sent with record=false, so looking back is not a read', async () => {
    const doc = fake.seedDoc(ME);
    await client.getVersion(doc.id, 1);
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/versions/1`)[0].query).toEqual({ record: 'false' });
    expect(doc.opens).toEqual([]);
  });

  test('a version that does not exist says what the document is at', async () => {
    const doc = fake.seedDoc(ME);
    const e = await caught(client.getVersion(doc.id, 7));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('has no version 7. It is at version 1');
    clean(e.message);
  });

  test('a bad version number is refused before any request', async () => {
    const doc = fake.seedDoc(ME);
    expect((await caught(client.getVersion(doc.id, 'latest'))).code).toBe('INVALID_PARAMS');
    expect(fake.log.length).toBe(0);
  });
});

describe('views', () => {
  test('one document: totals split into yours and others, each reader, agent reads apart', async () => {
    const doc = fake.seedDoc(ME);
    fake.seedOpen(doc, ME);
    fake.seedOpen(doc, 'p@x.com');
    fake.seedOpen(doc, null);
    fake.seedOpen(doc, ME, 1, 'mcp');
    const v = await client.views(doc.id);
    expect(v).toMatchObject({
      id: doc.id, version: 1, views: 3, ownerViews: 1, otherViews: 2, uniqueViewers: 3, otherViewers: 2, agentReads: 1,
      openedSinceLatestVersion: true, lastViewedVersion: 1,
    });
    expect(v.viewers.map((r) => [r.who, r.you])).toEqual([[ME, true], ['p@x.com', false], ['anonymous anon_1', false]]);
    expect(v.recent[0]).toMatchObject({ client: 'mcp', who: ME });
    clean(JSON.stringify(v));
  });

  test('every document: the summary the list shows', async () => {
    const read = fake.seedDoc(ME, { title: 'Read' });
    fake.seedOpen(read, 'p@x.com');
    fake.seedDoc(ME, { title: 'Unread' });
    fake.seedDoc('other@example.com');
    const s = await client.viewsSummary();
    expect(s.totals).toEqual({ documents: 2, opened: 1, neverOpened: 1, notOpenedSinceLatestVersion: 1, views: 1 });
    expect(s.documents.map((d) => [d.title, d.views, d.openedSinceLatestVersion])).toEqual([['Read', 1, true], ['Unread', 0, false]]);
    clean(JSON.stringify(s));
  });

  test('Kite 1.2.0, which counted only other people, still reads as others', async () => {
    const doc = fake.seedDoc(ME);
    fake.failNext(200, {
      artifactId: doc.id, version: 1, latestVersionAt: doc.updatedAt, retentionDays: 180,
      totals: { views: 2, uniqueViewers: 1, anonymousViewers: 0, agentFetches: 0 },
      lastViewedAt: null, lastViewedVersion: null, openedSinceLatestVersion: true, viewers: [], recent: [],
    });
    expect(await client.views(doc.id)).toMatchObject({ views: 2, ownerViews: 0, otherViews: 2, otherViewers: 1 });
  });

  test('a server without view tracking says so', async () => {
    fake.viewsApi = false;
    const doc = fake.seedDoc(ME);
    for (const p of [client.views(doc.id), client.viewsSummary()]) {
      const e = await caught(p);
      expect(e.message).toBe(`Kite at ${fake.url} does not have view tracking yet`);
      expect(e.suggestion).toContain('Kite 1.2.0 or later');
    }
  });
});
