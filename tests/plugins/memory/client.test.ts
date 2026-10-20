import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  formatSource,
  MemoryClient,
  parseCount,
  parseDocumentUrl,
  parseGroup,
  parseSource,
  retryPolicy,
  stripSpeaker,
} from '../../../src/plugins/memory/client';
import { entityFacts, listEpisodes, planForget, runForget, withSources } from '../../../src/plugins/memory/operations';
import { caught, FakeGraphiti, TOKEN } from './fake-graphiti';

let fake: FakeGraphiti;
let client: MemoryClient;
const originalDelay = retryPolicy.delayMs;

beforeEach(() => {
  fake = new FakeGraphiti();
  client = new MemoryClient({ baseUrl: `${fake.url}/`, token: TOKEN, defaultGroup: 'famille' });
  retryPolicy.delayMs = () => 0;
});

afterEach(() => {
  fake.stop();
  retryPolicy.delayMs = originalDelay;
});

describe('the ref convention', () => {
  test('ref and url round-trip through source_description', () => {
    expect(formatSource('1AbC_d-9')).toBe('ref:1AbC_d-9');
    const description = formatSource('Q3 plan/v2:final', 'https://docs.google.com/document/d/1AbC/edit?usp=sharing');
    expect(description).toBe('ref:Q3%20plan%2Fv2%3Afinal url:https://docs.google.com/document/d/1AbC/edit?usp=sharing');
    expect(parseSource(description)).toEqual({ ref: 'Q3 plan/v2:final', url: 'https://docs.google.com/document/d/1AbC/edit?usp=sharing' });
  });

  test('a description written by something else reads as no source; extra words are ignored', () => {
    expect(parseSource('')).toEqual({ ref: null, url: null });
    expect(parseSource('podcast transcript')).toEqual({ ref: null, url: null });
    expect(parseSource('imported ref:abc')).toEqual({ ref: 'abc', url: null });
    expect(parseSource('ref:%E0%A4%A')).toEqual({ ref: '%E0%A4%A', url: null });
  });

  test('the speaker prefix the server adds is removed from episode text', () => {
    expect(stripSpeaker('(user): Marie lives in Lyon')).toBe('Marie lives in Lyon');
    expect(stripSpeaker('bob(assistant): hi (there)')).toBe('hi (there)');
    expect(stripSpeaker('no prefix (user): here')).toBe('here');
    expect(stripSpeaker('plain text')).toBe('plain text');
  });
});

describe('option values', () => {
  test('groups are what Graphiti accepts', () => {
    expect(parseGroup(' famille ')).toBe('famille');
    expect(parseGroup('societes_2026-a')).toBe('societes_2026-a');
    for (const bad of ['', 'a b', 'é', 'x/y']) expect(() => parseGroup(bad)).toThrow();
  });

  test('counts and urls', () => {
    expect(parseCount('5', '--limit', 10)).toBe(5);
    for (const bad of ['0', '11', '-1', '2.5', 'x']) expect(() => parseCount(bad, '--limit', 10)).toThrow();
    expect(parseDocumentUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(() => parseDocumentUrl('ftp://example.com')).toThrow();
    expect(() => parseDocumentUrl('not a url')).toThrow();
  });
});

describe('requests', () => {
  test('add sends one message with our uuid, the ref convention and a null role', async () => {
    const added = await client.add({ group: 'famille', ref: 'doc-1', url: 'https://example.com/doc', text: 'Marie lives in Lyon', time: '2026-03-14T00:00:00.000Z' });
    expect(added).toMatchObject({ group: 'famille', ref: 'doc-1', url: 'https://example.com/doc', name: 'ref:doc-1', queued: true });
    const sent = fake.log[0];
    expect(sent).toMatchObject({ method: 'POST', path: '/messages', authorization: `Bearer ${TOKEN}` });
    expect(sent.body).toEqual({
      group_id: 'famille',
      messages: [{
        uuid: added.uuid,
        name: 'ref:doc-1',
        content: 'Marie lives in Lyon',
        role_type: 'user',
        role: null,
        source_description: 'ref:doc-1 url:https://example.com/doc',
        timestamp: '2026-03-14T00:00:00.000Z',
      }],
    });
    expect(fake.episodes[0].uuid).toBe(added.uuid);
  });

  test('add refuses empty text or ref before any request', async () => {
    expect((await caught(client.add({ group: 'g', ref: 'r', text: '  ' }))).code).toBe('INVALID_PARAMS');
    expect((await caught(client.add({ group: 'g', ref: ' ', text: 'x' }))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('a refused token is AUTH_FAILED and never printed', async () => {
    const wrong = new MemoryClient({ baseUrl: fake.url, token: 'SECRET-WRONG-TOKEN' });
    const err = await caught(wrong.health());
    expect(err.code).toBe('AUTH_FAILED');
    expect(`${err.message} ${err.suggestion}`).not.toContain('SECRET-WRONG-TOKEN');
  });

  test('a server message is shown without the token', async () => {
    fake.fail = { status: 500, body: { detail: `LLM call failed for key ${TOKEN}` }, count: 1 };
    const err = await caught(client.add({ group: 'g', ref: 'r', text: 'x' }));
    expect(err.code).toBe('API_ERROR');
    expect(err.message).toContain('[token]');
    expect(err.message).not.toContain(TOKEN);
  });

  test('a plain-text 500 is shown as text; an HTML error page is not', async () => {
    const text = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('Internal Server Error', { status: 500 }) });
    const html = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body>Bad gateway</body></html>', { status: 500 }) });
    try {
      const a = await caught(new MemoryClient({ baseUrl: `http://127.0.0.1:${text.port}`, token: TOKEN }).episodes('g', 1));
      expect(a.code).toBe('API_ERROR');
      expect(a.message).toBe('Graphiti server error: Internal Server Error');
      const b = await caught(new MemoryClient({ baseUrl: `http://127.0.0.1:${html.port}`, token: TOKEN }).episodes('g', 1));
      expect(b.message).toBe('The Graphiti server answered 500');
    } finally {
      text.stop(true);
      html.stop(true);
    }
  });

  test('FastAPI validation errors become INVALID_PARAMS naming the field', async () => {
    fake.fail = { status: 422, body: { detail: [{ loc: ['body', 'messages', 0, 'role'], msg: 'Field required' }] }, count: 1 };
    const err = await caught(client.add({ group: 'g', ref: 'r', text: 'x' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('messages.0.role: Field required');
  });

  test('reads are retried on 502/503/504; add is not', async () => {
    fake.fail = { status: 503, body: {}, count: 2 };
    expect(await client.search('Lyon', ['famille'], 5)).toEqual([]);
    expect(fake.log.filter((r) => r.path === '/search')).toHaveLength(3);

    fake.fail = { status: 503, body: {}, count: 3 };
    expect((await caught(client.search('Lyon', null, 5))).code).toBe('API_ERROR');

    fake.log.length = 0;
    fake.fail = { status: 503, body: {}, count: 1 };
    expect((await caught(client.add({ group: 'g', ref: 'r', text: 'x' }))).code).toBe('API_ERROR');
    expect(fake.log).toHaveLength(1);
  });

  test('a host that does not answer is NETWORK_ERROR', async () => {
    fake.stop();
    const err = await caught(client.health());
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toContain('127.0.0.1');
  });

  test('a server that is not Graphiti is CONFIG_ERROR', async () => {
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ hello: 'world' }) });
    try {
      const err = await caught(new MemoryClient({ baseUrl: `http://127.0.0.1:${other.port}`, token: TOKEN }).health());
      expect(err.code).toBe('CONFIG_ERROR');
    } finally {
      other.stop(true);
    }
  });

  test('groups: --group wins, then the default group; searches without either cover every group', () => {
    expect(client.group(undefined)).toBe('famille');
    expect(client.group('societes')).toBe('societes');
    expect(client.groups(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(client.groups(undefined)).toEqual(['famille']);
    const bare = new MemoryClient({ baseUrl: fake.url, token: TOKEN });
    expect(bare.groups(undefined)).toBeNull();
    expect(() => bare.group(undefined)).toThrow('No group given');
  });
});

describe('operations', () => {
  test('search facts carry the ref and url of the episodes they came from', async () => {
    const a = fake.seedEpisode('famille', formatSource('doc-a', 'https://example.com/a'));
    const b = fake.seedEpisode('famille', 'written by another tool');
    fake.seedFact('famille', 'Marie lives in Lyon', [a, b]);
    const facts = await withSources(client, await client.search('Lyon', ['famille'], 10), ['famille'], 100);
    expect(facts).toHaveLength(1);
    expect(facts[0].sources).toEqual([
      { episode: a.uuid, ref: 'doc-a', url: 'https://example.com/a' },
      { episode: b.uuid, ref: null, url: null },
    ]);
    expect(fake.log.find((r) => r.path === '/episodes/famille')?.query).toEqual({ last_n: '100' });
  });

  test('without groups, sources stay unresolved and no episode list is read', async () => {
    const a = fake.seedEpisode('famille', formatSource('doc-a'));
    fake.seedFact('famille', 'Marie lives in Lyon', [a]);
    const facts = await withSources(client, await client.search('Lyon', null, 10), null, 100);
    expect(facts[0].sources).toEqual([{ episode: a.uuid, ref: null, url: null }]);
    expect(fake.log.some((r) => r.path.startsWith('/episodes/'))).toBe(false);
  });

  test('episodes filter by ref, newest first, within the scan window', async () => {
    fake.seedEpisode('famille', formatSource('doc-a'), '(user): one');
    fake.seedEpisode('famille', formatSource('doc-b'), '(user): two');
    fake.seedEpisode('famille', formatSource('doc-a'), '(user): three');
    const all = await listEpisodes(client, 'famille', 10);
    expect(all.map((e) => e.text)).toEqual(['three', 'two', 'one']);
    const onlyA = await listEpisodes(client, 'famille', 10, 'doc-a', 100);
    expect(onlyA.map((e) => e.text)).toEqual(['three', 'one']);
    expect(onlyA[0]).toMatchObject({ ref: 'doc-a', group: 'famille' });
    // A scan smaller than the history misses older episodes.
    expect((await listEpisodes(client, 'famille', 2, 'doc-a', 2)).map((e) => e.text)).toEqual(['three']);
  });

  test('entity: the node the matching facts share, then the facts around it', async () => {
    const ep = fake.seedEpisode('famille', formatSource('doc-a'));
    fake.seedFact('famille', 'Marie lives in Lyon', [ep], ['marie', 'lyon']);
    fake.seedFact('famille', 'Marie works at Acme', [ep], ['marie', 'acme']);
    fake.seedFact('famille', 'Paul likes tennis', [ep], ['paul', 'tennis']);
    fake.seedFact('famille', 'She was born in 1990', [ep], ['marie', 'year-1990']);
    const result = await entityFacts(client, 'Marie', 'famille', 10, 100);
    expect(result.node).toBe('marie');
    expect(result.facts.map((f) => f.fact).sort()).toEqual(['Marie lives in Lyon', 'Marie works at Acme', 'She was born in 1990']);
    expect(result.facts[0].sources[0].ref).toBe('doc-a');
    const around = fake.log.find((r) => r.path === '/get-memory')!;
    expect(around.body).toMatchObject({ group_id: 'famille', center_node_uuid: 'marie', messages: [{ content: 'Marie', role_type: 'user', role: null }] });
  });

  test('entity: no fact names it, no node', async () => {
    expect(await entityFacts(client, 'Nobody', 'famille', 10, 100)).toEqual({ entity: 'Nobody', group: 'famille', node: null, facts: [] });
    expect(fake.log.some((r) => r.path === '/get-memory')).toBe(false);
  });

  test('forget deletes the ref\'s episodes and the facts only they support', async () => {
    const a1 = fake.seedEpisode('famille', formatSource('doc-a'));
    const a2 = fake.seedEpisode('famille', formatSource('doc-a', 'https://example.com/a'));
    const b = fake.seedEpisode('famille', formatSource('doc-b'));
    const other = fake.seedEpisode('societes', formatSource('doc-a'));
    const onlyA = fake.seedFact('famille', 'only from a', [a1, a2]);
    const shared = fake.seedFact('famille', 'from a and b', [a2, b]);
    fake.seedFact('societes', 'other group', [other]);

    const plan = await planForget(client, 'doc-a', 'famille', 100, false);
    expect(plan.episodes.map((e) => e.uuid).sort()).toEqual([a1.uuid, a2.uuid].sort());
    expect(plan.facts).toEqual([onlyA.uuid]);
    expect(plan.keptFacts).toEqual([shared.uuid]);

    const result = await runForget(client, plan);
    expect(result.failed).toEqual([]);
    expect(fake.episodes.map((e) => e.uuid).sort()).toEqual([b.uuid, other.uuid].sort());
    expect(fake.facts.map((f) => f.fact).sort()).toEqual(['from a and b', 'other group']);
  });

  test('forget --keep-facts deletes episodes only; an id already gone counts as deleted', async () => {
    const a = fake.seedEpisode('famille', formatSource('doc-a'));
    fake.seedFact('famille', 'only from a', [a]);
    const plan = await planForget(client, 'doc-a', 'famille', 100, true);
    expect(plan.facts).toEqual([]);
    fake.episodes = [];
    const result = await runForget(client, plan);
    expect(result.deletedEpisodes).toEqual([a.uuid]);
    expect(fake.facts).toHaveLength(1);
  });

  test('forget reports a deletion that failed and carries on', async () => {
    fake.seedEpisode('famille', formatSource('doc-a'));
    fake.seedEpisode('famille', formatSource('doc-a'));
    const plan = await planForget(client, 'doc-a', 'famille', 100, false);
    fake.fail = { status: 500, body: { detail: 'driver error' }, count: 1 };
    const result = await runForget(client, plan);
    expect(result.failed).toHaveLength(1);
    expect(result.deletedEpisodes).toHaveLength(1);
  });
});
