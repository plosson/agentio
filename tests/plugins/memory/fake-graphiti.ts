/**
 * An in-process Graphiti REST server (getzep/graphiti `server/graph_service`) behind a bearer-token proxy,
 * on 127.0.0.1 with a random port. It answers the routes and shapes of routers/ingest.py and
 * routers/retrieve.py: `/messages` answers 202 and stores the episode (facts are added by the test, as
 * the server's LLM would), `/episodes/{group_id}` needs `last_n`, unknown ids answer 404 `{ detail }`,
 * and a body that misses a required field answers 422 with FastAPI's `{ detail: [{ loc, msg }] }`.
 */

import { expect } from 'bun:test';
import { CliError } from '../../../src/utils/errors';

export async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected a CliError, got success');
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: any;
}

export interface StoredEpisode {
  uuid: string;
  name: string;
  group_id: string;
  source_description: string;
  content: string;
  created_at: string;
  valid_at: string;
  entity_edges: string[];
}

export interface StoredFact {
  uuid: string;
  name: string;
  fact: string;
  group_id: string;
  source_node_uuid: string;
  target_node_uuid: string;
  episodes: string[];
}

export const TOKEN = 'test-graphiti-token-0123456789';

export class FakeGraphiti {
  readonly log: LoggedRequest[] = [];
  episodes: StoredEpisode[] = [];
  facts: StoredFact[] = [];
  /** The next `count` requests (after auth) answer with this. */
  fail: { status: number; body: unknown; count: number } | null = null;
  private seq = 0;
  private server: ReturnType<typeof Bun.serve>;

  constructor(readonly token = TOKEN) {
    this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** An episode already in the graph. Newer seeds are more recent. */
  seedEpisode(group: string, sourceDescription: string, content = '(user): something', name = 'ep'): StoredEpisode {
    const n = this.seq++;
    const episode: StoredEpisode = {
      uuid: `ep-${n}`,
      name,
      group_id: group,
      source_description: sourceDescription,
      content,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
      valid_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
      entity_edges: [],
    };
    this.episodes.push(episode);
    return episode;
  }

  /** A fact the server's LLM would have extracted from `episodes`. */
  seedFact(group: string, fact: string, episodes: StoredEpisode[], nodes: [string, string] = ['node-a', 'node-b'], name = 'RELATES_TO'): StoredFact {
    const stored: StoredFact = {
      uuid: `fact-${this.seq++}`,
      name,
      fact,
      group_id: group,
      source_node_uuid: nodes[0],
      target_node_uuid: nodes[1],
      episodes: episodes.map((e) => e.uuid),
    };
    for (const episode of episodes) episode.entity_edges.push(stored.uuid);
    this.facts.push(stored);
    return stored;
  }

  private factResult(f: StoredFact) {
    return {
      uuid: f.uuid,
      name: f.name,
      fact: f.fact,
      valid_at: null,
      invalid_at: null,
      created_at: '2026-01-02T00:00:00Z',
      expired_at: null,
      source_node_uuid: f.source_node_uuid,
      target_node_uuid: f.target_node_uuid,
      episodes: f.episodes,
    };
  }

  private matches(f: StoredFact, query: string): boolean {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return words.some((w) => f.fact.toLowerCase().includes(w));
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const text = await req.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    this.log.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), authorization: req.headers.get('authorization'), body });
    const json = (status: number, data: unknown) => Response.json(data, { status });

    // The proxy: no or a wrong token never reaches the server.
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) return new Response('<html>401 Authorization Required</html>', { status: 401 });
    if (this.fail && this.fail.count > 0) {
      this.fail.count--;
      return json(this.fail.status, this.fail.body);
    }
    const missing = (loc: string) => json(422, { detail: [{ type: 'missing', loc: ['body', ...loc.split('.')], msg: 'Field required' }] });

    if (req.method === 'GET' && path === '/healthcheck') return json(200, { status: 'healthy' });

    if (req.method === 'POST' && path === '/messages') {
      if (!body?.group_id) return missing('group_id');
      if (!Array.isArray(body.messages)) return missing('messages');
      for (const [i, m] of body.messages.entries()) {
        if (typeof m.content !== 'string') return missing(`messages.${i}.content`);
        if (!['user', 'assistant', 'system'].includes(m.role_type)) return missing(`messages.${i}.role_type`);
        if (!('role' in m)) return missing(`messages.${i}.role`);
      }
      for (const m of body.messages) {
        const n = this.seq++;
        const at = m.timestamp ?? new Date(Date.UTC(2026, 0, 1, 1, n)).toISOString();
        this.episodes.push({
          uuid: m.uuid ?? `ep-${n}`,
          name: m.name ?? '',
          group_id: body.group_id,
          source_description: m.source_description ?? '',
          content: `${m.role ?? ''}(${m.role_type}): ${m.content}`,
          created_at: at,
          valid_at: at,
          entity_edges: [],
        });
      }
      return json(202, { message: 'Messages added to processing queue', success: true });
    }

    if (req.method === 'POST' && path === '/search') {
      if (typeof body?.query !== 'string') return missing('query');
      const groups: string[] | null = body.group_ids ?? null;
      const facts = this.facts
        .filter((f) => !groups || groups.includes(f.group_id))
        .filter((f) => this.matches(f, body.query))
        .slice(0, body.max_facts ?? 10);
      return json(200, { facts: facts.map((f) => this.factResult(f)) });
    }

    if (req.method === 'POST' && path === '/get-memory') {
      if (!body?.group_id) return missing('group_id');
      if (!('center_node_uuid' in body)) return missing('center_node_uuid');
      if (!Array.isArray(body.messages)) return missing('messages');
      const center = body.center_node_uuid;
      const facts = this.facts
        .filter((f) => f.group_id === body.group_id)
        .sort((a, b) => Number(b.source_node_uuid === center || b.target_node_uuid === center) - Number(a.source_node_uuid === center || a.target_node_uuid === center))
        .slice(0, body.max_facts ?? 10);
      return json(200, { facts: facts.map((f) => this.factResult(f)) });
    }

    let m = /^\/episodes\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const lastN = url.searchParams.get('last_n');
      if (lastN === null) return json(422, { detail: [{ type: 'missing', loc: ['query', 'last_n'], msg: 'Field required' }] });
      const list = this.episodes
        .filter((e) => e.group_id === m![1])
        .sort((a, b) => b.valid_at.localeCompare(a.valid_at))
        .slice(0, Number(lastN));
      return json(200, list.map((e) => ({ ...e, labels: ['Episodic'], source: 'message' })));
    }

    m = /^\/entity-edge\/([^/]+)$/.exec(path);
    if (m) {
      const fact = this.facts.find((f) => f.uuid === m![1]);
      if (!fact) return json(404, { detail: `edge ${m[1]} not found` });
      if (req.method === 'GET') return json(200, this.factResult(fact));
      if (req.method === 'DELETE') {
        this.facts = this.facts.filter((f) => f !== fact);
        return json(200, { message: 'Entity Edge deleted', success: true });
      }
    }

    m = /^\/episode\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      const episode = this.episodes.find((e) => e.uuid === m![1]);
      if (!episode) return json(404, { detail: `node ${m[1]} not found` });
      // As the real server: the episode node only; its facts stay.
      this.episodes = this.episodes.filter((e) => e !== episode);
      return json(200, { message: 'Episode deleted', success: true });
    }

    return json(404, { detail: 'Not Found' });
  }
}
