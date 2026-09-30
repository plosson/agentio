import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  KiteClient,
  commentPosition,
  formatFromPath,
  normaliseBaseUrl,
  parseDuration,
  readDocumentFile,
  requireDocumentId,
  resolveReference,
  sanitise,
  shareTarget,
} from '../../../src/plugins/kite/client';
import { CliError, exitCodeForError, type ErrorCode } from '../../../src/utils/errors';
import { FakeKite } from './fake-kite';

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

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected a CliError, got success');
}

function expectCode(e: CliError, code: ErrorCode, exit: number) {
  expect(e.code).toBe(code);
  expect(exitCodeForError(e.code)).toBe(exit);
}

function mustNotLeak(e: CliError) {
  const text = `${e.message} ${e.suggestion ?? ''} ${JSON.stringify(e)}`;
  expect(text).not.toContain(token);
  expect(text.toLowerCase()).not.toContain('artifact');
}

describe('transport and auth', () => {
  test('every request carries the bearer token', async () => {
    await client.list();
    await client.me();
    expect(fake.log.length).toBe(2);
    for (const r of fake.log) expect(r.headers.authorization).toBe(`Bearer ${token}`);
  });

  test('Content-Type is sent only with a body', async () => {
    await client.list();
    await client.publish({ type: 'markdown', content: '# x' });
    const [get, post] = fake.log;
    expect(get.headers['content-type']).toBeUndefined();
    expect(get.rawBody).toBe('');
    expect(post.headers['content-type']).toBe('application/json');
  });

  test('a trailing slash in baseUrl produces no double slash', async () => {
    const c = new KiteClient({ baseUrl: `${fake.url}///`, token });
    await c.list();
    expect(fake.log[0].path).toBe('/api/artifacts');
  });

  test('the token never appears in errors: 401, 500 echoing it, network', async () => {
    fake.failNext(401, { error: { code: 'unauthenticated', message: `bad token ${token}` } });
    mustNotLeak(await caught(client.list()));
    fake.failNext(500, { error: { code: 'internal_error', message: `boom ${token}` } });
    const e500 = await caught(client.list());
    mustNotLeak(e500);
    expect(e500.message).toContain('[token]');
    fake.stop();
    mustNotLeak(await caught(client.list()));
  });
});

describe('error mapping', () => {
  const cases: Array<[string, number, unknown, ErrorCode, number, string]> = [
    ['401 unauthenticated', 401, { error: { code: 'unauthenticated', message: 'x' } }, 'AUTH_EXPIRED', 2, 'profile reauth kite'],
    ['403 forbidden', 403, { error: { code: 'forbidden', message: 'x' } }, 'PERMISSION_DENIED', 2, 'owner'],
    ['404 not_found', 404, { error: { code: 'not_found', message: 'x' } }, 'NOT_FOUND', 5, 'may not be yours'],
    ['410 gone', 410, { error: { code: 'gone', message: 'x', details: { expiredAt: '2026-02-02T00:00:00Z' } } }, 'NOT_FOUND', 5, ''],
    ['400 validation_failed', 400, { error: { code: 'validation_failed', message: 'Bad thing.' } }, 'INVALID_PARAMS', 1, ''],
    ['400 unsupported_type', 400, { error: { code: 'unsupported_type', message: 'x' } }, 'INVALID_PARAMS', 1, ''],
    ['413 payload_too_large', 413, { error: { code: 'payload_too_large', message: 'x', details: { maxBytes: 42 } } }, 'INVALID_PARAMS', 1, ''],
    ['409 version_conflict', 409, { error: { code: 'version_conflict', message: 'x', details: { currentVersion: 3, baseVersion: 2 } } }, 'API_ERROR', 5, ''],
    ['500 internal_error', 500, { error: { code: 'internal_error', message: 'x', details: { requestId: 'req_9' } } }, 'API_ERROR', 5, 'req_9'],
  ];
  for (const [name, status, body, code, exit, suggests] of cases) {
    test(name, async () => {
      fake.failNext(status, body);
      const e = await caught(client.list());
      expectCode(e, code, exit);
      if (suggests) expect(e.suggestion ?? '').toContain(suggests);
      mustNotLeak(e);
    });
  }

  test('401 with an empty body is AUTH_EXPIRED', async () => {
    fake.failNextText(401, '');
    expectCode(await caught(client.list()), 'AUTH_EXPIRED', 2);
  });

  test('404 with an HTML body is NOT_FOUND, not a parse crash', async () => {
    fake.failNextText(404, '<html><body>Not here</body></html>', { 'Content-Type': 'text/html' });
    expectCode(await caught(client.list()), 'NOT_FOUND', 5);
  });

  test('502 with an HTML body is API_ERROR and carries x-request-id', async () => {
    fake.failNextText(502, '<html>Bad gateway</html>', { 'x-request-id': 'edge-1' });
    const e = await caught(client.list());
    expectCode(e, 'API_ERROR', 5);
    expect(e.suggestion).toContain('edge-1');
  });

  test('410 mentions the expiry and when', async () => {
    fake.failNext(410, { error: { code: 'gone', message: 'x', details: { expiredAt: '2026-02-02T00:00:00Z' } } });
    const e = await caught(client.get('art_x'));
    expect(e.message).toContain('expired');
    expect(e.message).toContain('2026-02-02T00:00:00Z');
  });

  test('413 includes maxBytes', async () => {
    fake.maxBytes = 10;
    const e = await caught(client.publish({ type: 'markdown', content: 'x'.repeat(11) }));
    expectCode(e, 'INVALID_PARAMS', 1);
    expect(e.message).toContain('10');
  });

  test('429 gives RATE_LIMITED with Retry-After, and no retry', async () => {
    fake.rateLimitNext(37);
    const e = await caught(client.list());
    expectCode(e, 'RATE_LIMITED', 5);
    expect(e.suggestion).toContain('37');
    expect(fake.log.length).toBe(1);
  });

  test('a rejected fetch gives NETWORK_ERROR naming the host', async () => {
    const url = fake.url;
    fake.stop();
    const e = await caught(client.list());
    expectCode(e, 'NETWORK_ERROR', 4);
    expect(e.message).toContain(url);
  });

  test('server messages lose the word artifact, keeping case', () => {
    expect(sanitise('No such artifact.')).toBe('No such document.');
    expect(sanitise('Artifacts are private')).toBe('Documents are private');
    expect(sanitise('ARTIFACT gone')).toBe('DOCUMENT gone');
    expect(sanitise('artifactId art_1 and myartifact')).toBe('artifactId art_1 and myartifact');
  });

  test('a server message is shown sanitised', async () => {
    fake.failNext(400, { error: { code: 'validation_failed', message: 'This artifact is empty.' } });
    const e = await caught(client.list());
    expect(e.message).toBe('This document is empty.');
  });
});

describe('publish and update', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'kite-files-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('the extension picks the type, case-insensitively', () => {
    expect(formatFromPath('a.md')).toBe('markdown');
    expect(formatFromPath('a.MARKDOWN')).toBe('markdown');
    expect(formatFromPath('a.html')).toBe('html');
    expect(formatFromPath('a.HTM')).toBe('html');
  });

  test('other extensions are refused before any request', async () => {
    for (const name of ['a.txt', 'noext', 'a.md.bak']) {
      await writeFile(join(dir, name), 'x');
      expect((await caught(readDocumentFile(join(dir, name)))).code).toBe('INVALID_PARAMS');
    }
    expect(fake.log.length).toBe(0);
  });

  test('a missing file or a directory is refused, naming the path', async () => {
    const missing = join(dir, 'nope.md');
    expect((await caught(readDocumentFile(missing))).message).toContain(missing);
    const folder = join(dir, 'folder.md');
    await mkdir(folder);
    const e = await caught(readDocumentFile(folder));
    expect(e.code).toBe('INVALID_PARAMS');
    expect(e.message).toContain(folder);
  });

  test('an empty file reaches the server and its 400 is mapped', async () => {
    await writeFile(join(dir, 'empty.md'), '');
    const doc = await readDocumentFile(join(dir, 'empty.md'));
    const e = await caught(client.publish(doc));
    expect(e.code).toBe('INVALID_PARAMS');
    expect(fake.requests('POST').length).toBe(1);
    mustNotLeak(e);
  });

  test('UTF-8 content round-trips byte for byte', async () => {
    const content = '# Émoji 🪁\r\nline two\r\n\u0001ÿ  end';
    await writeFile(join(dir, 'u.md'), content);
    const published = await client.publish(await readDocumentFile(join(dir, 'u.md')));
    expect((await client.get(published.id)).content).toBe(content);
  });

  test('title is sent only when given; a blank title is refused locally', async () => {
    await client.publish({ type: 'markdown', content: 'x' });
    expect(fake.log[0].body).not.toHaveProperty('title');
    await client.publish({ type: 'markdown', content: 'x', title: 'T' });
    expect((fake.log[1].body as any).title).toBe('T');
    expect((await caught(client.publish({ type: 'markdown', content: 'x', title: '  ' }))).code).toBe('INVALID_PARAMS');
    expect(fake.log.length).toBe(2);
  });

  test('update reads, then writes against the version it read', async () => {
    const doc = fake.seedDoc(ME, { version: 4 });
    const updated = await client.update(doc.id, { type: 'markdown', content: 'new' });
    expect(fake.log.map((r) => r.method)).toEqual(['GET', 'PUT']);
    expect((fake.log[1].body as any).baseVersion).toBe(4);
    expect(updated.version).toBe(5);
  });

  test('a change between the read and the write is a conflict, with exactly one PUT', async () => {
    const doc = fake.seedDoc(ME, { version: 1 });
    fake.after((r) => r.method === 'GET', () => { doc.version = 7; });
    const e = await caught(client.update(doc.id, { type: 'markdown', content: 'new' }));
    expectCode(e, 'API_ERROR', 5);
    expect(e.message).toContain('Someone changed this document since you read it');
    expect(e.message).toContain('version 7');
    expect(e.message).toContain('you had 1');
    expect(fake.requests('PUT').length).toBe(1);
  });

  test("updating someone else's document is NOT_FOUND with no PUT", async () => {
    const doc = fake.seedDoc('other@example.com');
    expect((await caught(client.update(doc.id, { type: 'markdown', content: 'x' }))).code).toBe('NOT_FOUND');
    expect(fake.requests('PUT').length).toBe(0);
  });

  test('switching from Markdown to HTML sends the new type', async () => {
    const doc = fake.seedDoc(ME, { type: 'markdown' });
    await client.update(doc.id, { type: 'html', content: '<p>x</p>' });
    expect((fake.requests('PUT')[0].body as any).type).toBe('html');
    expect(fake.docs.get(doc.id)!.type).toBe('html');
  });

  test('update refuses a link instead of an id, with no request', async () => {
    const e = await caught(client.update('https://h/a/slug', { type: 'markdown', content: 'x' }));
    expect(e.code).toBe('INVALID_PARAMS');
    expect(e.suggestion).toContain('kite get');
    expect(fake.log.length).toBe(0);
  });
});

describe('get, list, delete', () => {
  test('resolveReference', () => {
    expect(resolveReference('art_x')).toEqual({ kind: 'id', id: 'art_x' });
    expect(resolveReference('  art_x  ')).toEqual({ kind: 'id', id: 'art_x' });
    for (const input of ['https://h/a/SLUG', 'https://h/a/SLUG?thread=thr_1#x', '/a/SLUG', 'SLUG', 'https://h/a/a/SLUG', 'https://h/a/SLUG/']) {
      expect(resolveReference(input)).toEqual({ kind: 'slug', slug: 'SLUG' });
    }
    for (const bad of ['', '   ', 'https://h/a/', 'https://h/other/thing', 'https://h/a/?x=1']) {
      expect(() => resolveReference(bad)).toThrow(CliError);
    }
  });

  test('a link goes by slug, an id by id', async () => {
    const doc = fake.seedDoc(ME);
    const byLink = await client.get(`${fake.url}/a/${doc.slug}?thread=thr_1`);
    const byId = await client.get(doc.id);
    expect(fake.log.map((r) => r.path)).toEqual([`/api/artifacts/by-slug/${doc.slug}`, `/api/artifacts/${doc.id}`]);
    expect(byLink.id).toBe(doc.id);
    expect(byId.content).toBe('# Hello');
  });

  test('an expired share link is NOT_FOUND mentioning expiry', async () => {
    const doc = fake.seedDoc(ME, { expiresAt: '2020-01-01T00:00:00Z' });
    const e = await caught(client.get(`/a/${doc.slug}`));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('expired');
  });

  test('list keeps the order and carries no content', async () => {
    const a = fake.seedDoc(ME, { title: 'A' });
    const b = fake.seedDoc(ME, { title: 'B' });
    fake.seedDoc('other@example.com', { title: 'C' });
    const docs = await client.list();
    expect(docs.map((d) => d.id)).toEqual([b.id, a.id]);
    for (const d of docs) {
      expect(d).not.toHaveProperty('content');
      expect(Object.keys(d).sort()).toEqual(['id', 'title', 'type', 'updated', 'url', 'version']);
    }
  });

  test('delete sends confirm=true', async () => {
    const doc = fake.seedDoc(ME);
    await client.delete(doc.id);
    expect(fake.log[0].method).toBe('DELETE');
    expect(fake.log[0].query).toEqual({ confirm: 'true' });
    expect(fake.docs.has(doc.id)).toBe(false);
  });

  test('delete of an unknown id is NOT_FOUND', async () => {
    expect((await caught(client.delete('art_nope'))).code).toBe('NOT_FOUND');
  });

  test('requireDocumentId refuses links and slugs', () => {
    expect(requireDocumentId(' art_1 ')).toBe('art_1');
    for (const bad of ['https://h/a/x', 'slug', 'art_', 'art_x/../y', '']) expect(() => requireDocumentId(bad)).toThrow(CliError);
  });
});

describe('sharing', () => {
  test('email vs domain', () => {
    expect(shareTarget('a@b.com')).toEqual({ kind: 'email', value: 'a@b.com' });
    expect(shareTarget('@example.com')).toEqual({ kind: 'domain', value: 'example.com' });
    expect(shareTarget('example.com')).toEqual({ kind: 'domain', value: 'example.com' });
    expect(() => shareTarget('')).toThrow(CliError);
    expect(() => shareTarget('@')).toThrow(CliError);
  });

  test('an email with + and / is encoded in the DELETE path', async () => {
    const doc = fake.seedDoc(ME);
    await client.share(doc.id, 'a+b/c@x.com');
    await client.unshare(doc.id, 'a+b/c@x.com');
    const del = fake.requests('DELETE')[0];
    expect(del.path).toBe(`/api/artifacts/${doc.id}/sharing/people/a%2Bb%2Fc%40x.com`);
    expect(fake.docs.get(doc.id)!.people).toEqual([]);
  });

  test('201 means notified, 200 means already shared', async () => {
    const doc = fake.seedDoc(ME);
    expect((await client.share(doc.id, 'p@x.com')).notified).toBe(true);
    const again = await client.share(doc.id, 'p@x.com');
    expect(again.notified).toBe(false);
    expect(again.people).toEqual([{ email: 'p@x.com', pending: true }]);
  });

  test('a domain share never counts as notified, new or not', async () => {
    const doc = fake.seedDoc(ME);
    expect((await client.share(doc.id, 'example.org')).notified).toBe(false);
    expect(fake.requests('POST')[0].body).toEqual({ domain: 'example.org' });
    expect((await client.share(doc.id, '@example.org')).notified).toBe(false);
  });

  test('a public mail provider domain is INVALID_PARAMS', async () => {
    const doc = fake.seedDoc(ME);
    const e = await caught(client.share(doc.id, 'gmail.com'));
    expect(e.code).toBe('INVALID_PARAMS');
    expect(fake.docs.get(doc.id)!.domains).toEqual([]);
  });

  test('removing someone not shared with is NOT_FOUND', async () => {
    const doc = fake.seedDoc(ME);
    expect((await caught(client.unshare(doc.id, 'x.com'))).code).toBe('NOT_FOUND');
  });

  test('public and private send booleans', async () => {
    const doc = fake.seedDoc(ME);
    expect((await client.setPublic(doc.id, true)).isPublic).toBe(true);
    expect((await client.setPublic(doc.id, false)).isPublic).toBe(false);
    expect(fake.requests('PUT').map((r) => r.body)).toEqual([{ isPublic: true }, { isPublic: false }]);
  });

  test("sharing someone else's document is NOT_FOUND", async () => {
    const doc = fake.seedDoc('other@example.com');
    expect((await caught(client.sharing(doc.id))).code).toBe('NOT_FOUND');
  });

  test('expiry sends the normalised duration; a bad one sends nothing', async () => {
    const doc = fake.seedDoc(ME);
    await client.setExpiry(doc.id, '2 HOURS');
    expect(fake.log[0].body).toEqual({ expiresIn: '2h' });
    expect((await caught(client.setExpiry(doc.id, '30'))).code).toBe('INVALID_PARAMS');
    expect(fake.log.length).toBe(1);
  });
});

describe('parseDuration', () => {
  test('accepted', () => {
    expect(parseDuration('12h')).toBe('12h');
    expect(parseDuration('30d')).toBe('30d');
    expect(parseDuration('1 day')).toBe('1d');
    expect(parseDuration('2 HOURS')).toBe('2h');
    expect(parseDuration('3hrs')).toBe('3h');
    expect(parseDuration('3650d')).toBe('3650d');
    for (const f of ['forever', 'never', 'none', 'Forever']) expect(parseDuration(f)).toBe('forever');
  });

  test('refused', () => {
    for (const bad of ['30', '0d', '-1d', '1w', '4000d', '87601h', '', '1.5d', '30dd', 'd', 'forever!']) {
      expect(() => parseDuration(bad)).toThrow(CliError);
    }
  });
});

describe('comments', () => {
  test('status and since are only sent when given, and encoded', async () => {
    const doc = fake.seedDoc(ME);
    await client.comments(doc.id);
    expect(fake.log[0].query).toEqual({});
    await client.comments(doc.id, { status: 'open', since: '2026-01-01T00:00:00+02:00' });
    expect(fake.log[1].query).toEqual({ status: 'open', since: '2026-01-01T00:00:00+02:00' });
    expect(fake.log[1].path).toBe(`/api/artifacts/${doc.id}/comments`);
  });

  test('a bad --since or --status is refused locally', async () => {
    const doc = fake.seedDoc(ME);
    expect((await caught(client.comments(doc.id, { since: 'yesterday-ish' }))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.comments(doc.id, { status: 'closed' }))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.comments(doc.id, { since: '' }))).code).toBe('INVALID_PARAMS');
    expect(fake.log.length).toBe(0);
  });

  test('since keeps threads whose newest comment is strictly later', async () => {
    const doc = fake.seedDoc(ME);
    const t = await client.comment(doc.id, { body: 'first' });
    const cutoff = t.comments[0].createdAt;
    expect(await client.comments(doc.id, { since: cutoff })).toEqual([]);
    await client.reply(t.id, 'later');
    expect((await client.comments(doc.id, { since: cutoff })).map((x) => x.id)).toEqual([t.id]);
  });

  test('the three add shapes', async () => {
    const doc = fake.seedDoc(ME);
    await client.comment(doc.id, { body: 'doc-level' });
    await client.comment(doc.id, { body: 'b', snippet: 'exact rendered text' });
    await client.comment(doc.id, { body: 'b', snippet: 'exact rendered text', heading: 'intro' });
    const bodies = fake.requests('POST').map((r) => r.body as Record<string, unknown>);
    expect(bodies[0]).toEqual({ body: 'doc-level' });
    expect(bodies[1]).toEqual({ body: 'b', position: { snippet: 'exact rendered text' } });
    expect(bodies[1].position).not.toHaveProperty('headingId');
    expect(bodies[2]).toEqual({ body: 'b', position: { snippet: 'exact rendered text', headingId: 'intro' } });
  });

  test('--heading without --snippet is refused, --element-id sends elementId', async () => {
    expect(() => commentPosition({ body: 'b', heading: 'h' })).toThrow(CliError);
    expect(commentPosition({ body: 'b', elementId: 'fig-1' })).toEqual({ elementId: 'fig-1' });
    const doc = fake.seedDoc(ME, { type: 'html' });
    await client.comment(doc.id, { body: 'b', elementId: 'fig-1' });
    expect((fake.log[0].body as any).position).toEqual({ elementId: 'fig-1' });
  });

  test('an empty body is refused locally', async () => {
    const doc = fake.seedDoc(ME);
    expect((await caught(client.comment(doc.id, { body: '   ' }))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.reply('thr_1', ''))).code).toBe('INVALID_PARAMS');
    expect(fake.log.length).toBe(0);
  });

  test('a too-short snippet reaches the server, which stays the authority', async () => {
    const doc = fake.seedDoc(ME);
    const e = await caught(client.comment(doc.id, { body: 'b', snippet: 'short' }));
    expect(e.code).toBe('INVALID_PARAMS');
    expect(e.message).not.toMatch(/artifact/i);
    expect(fake.log.length).toBe(1);
  });

  test('reply and status send the right bodies; mentions are preserved', async () => {
    const doc = fake.seedDoc(ME);
    const t = await client.comment(doc.id, { body: 'q' });
    expect(t.mentions).toEqual({ notified: [], shared: [], awaitingAccess: [] });
    const r = await client.reply(t.id, 'a');
    expect(r.mentions).toEqual({ notified: [], shared: [], awaitingAccess: [] });
    await client.setThreadStatus(t.id, 'resolved');
    await client.setThreadStatus(t.id, 'open');
    expect(fake.log[1].body).toEqual({ body: 'a' });
    expect(fake.log[2].body).toEqual({ status: 'resolved' });
    expect(fake.log[3].body).toEqual({ status: 'open' });
  });

  test('resolve by someone who is neither author nor owner is PERMISSION_DENIED', async () => {
    const doc = fake.seedDoc('owner@example.com', { isPublic: true });
    const ownerClient = new KiteClient({ baseUrl: fake.url, token: fake.issueToken('owner@example.com') });
    const t = await ownerClient.comment(doc.id, { body: 'owner thread' });
    const e = await caught(client.setThreadStatus(t.id, 'resolved'));
    expectCode(e, 'PERMISSION_DENIED', 2);
    expect(fake.threads.get(t.id)!.status).toBe('open');
  });

  test('threads carry anchorDrifted and author emails', async () => {
    const doc = fake.seedDoc(ME);
    await client.comment(doc.id, { body: 'x' });
    const [thread] = await client.comments(doc.id);
    expect(thread).toHaveProperty('anchorDrifted', false);
    expect(thread.comments[0]).toEqual({ author: ME, body: 'x', createdAt: expect.any(String) });
  });
});

describe('validate', () => {
  test('200 is valid with the email', async () => {
    expect(await client.validate()).toEqual({ valid: true, info: ME });
  });

  test('401 is invalid with the reauth suggestion, not a throw', async () => {
    fake.revoke(token);
    const result = await client.validate();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('agentio profile reauth kite');
    expect(result.error).not.toContain(token);
  });
});

describe('normaliseBaseUrl', () => {
  test('adds https, keeps http for localhost, drops trailing slashes', () => {
    expect(normaliseBaseUrl('kite.example')).toBe('https://kite.example');
    expect(normaliseBaseUrl('http://localhost:4000/')).toBe('http://localhost:4000');
    expect(normaliseBaseUrl(' https://kite.example/// ')).toBe('https://kite.example');
  });

  test('refuses other schemes and garbage', () => {
    for (const bad of ['ftp://kite.example', '', '   ', 'http://', 'https://user:pw@kite.example', 'javascript://x']) {
      expect(() => normaliseBaseUrl(bad)).toThrow(CliError);
    }
  });
});

