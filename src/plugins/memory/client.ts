import type { ServiceClient, ValidationResult } from '../../types/service';
import { normaliseServerUrl } from '../../utils/base-url';
import { CliError } from '../../utils/errors';
import type {
  GraphitiEpisode,
  GraphitiFact,
  MemoryAdded,
  MemoryAddInput,
  MemoryCredentials,
  MemoryEpisode,
  MemorySource,
} from './types';

/**
 * The REST server of Graphiti (https://github.com/getzep/graphiti, `server/graph_service`), reached through a
 * proxy that wants `Authorization: Bearer <token>`. The routes and shapes are those of
 * `routers/ingest.py`, `routers/retrieve.py` and `dto/*.py`:
 *
 * - `GET /healthcheck` → `{ status: 'healthy' }`
 * - `POST /messages` `{ group_id, messages: [Message] }` → 202; facts are extracted later, by a queue
 * - `POST /search` `{ group_ids, query, max_facts }` → `{ facts: [FactResult] }`
 * - `POST /get-memory` `{ group_id, max_facts, center_node_uuid, messages }` → `{ facts }`
 * - `GET /episodes/{group_id}?last_n=N` → the N most recent `EpisodicNode`s
 * - `GET /entity-edge/{uuid}`, `DELETE /entity-edge/{uuid}`, `DELETE /episode/{uuid}`
 *
 * The server keeps no index on `source_description`, so every lookup by ref lists a group's
 * episodes and filters them here.
 */

const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_FACTS = 200;
export const MAX_EPISODES = 10_000;
/** How many recent episodes are read to find a ref when no `--scan` is given. */
export const DEFAULT_SCAN = 1000;
/** Retries after the first attempt, for requests that are safe to repeat. */
const RETRIES = 2;
const GROUP_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Delay before retry `attempt` (1-based); tests set it to 0. */
export const retryPolicy = { delayMs: (attempt: number) => 400 * attempt };

export function normaliseMemoryUrl(input: string): string {
  return normaliseServerUrl(input, 'Graphiti server', 'https://graphiti.example.com');
}

/** A group id as Graphiti accepts it (graphiti_core/helpers.py validate_group_id): letters, digits, - and _. */
export function parseGroup(input: string, option = '--group'): string {
  const group = input.trim();
  if (!GROUP_PATTERN.test(group)) {
    throw new CliError('INVALID_PARAMS', `${option} must be letters, digits, - and _ only, not "${input}"`, 'For example: --group famille');
  }
  return group;
}

/** A whole number from 1 to `max`, for `--limit` and `--scan`. */
export function parseCount(input: string, option: string, max: number): number {
  const n = Number(input);
  if (!/^\d+$/.test(input.trim()) || !Number.isInteger(n) || n < 1 || n > max) {
    throw new CliError('INVALID_PARAMS', `${option} must be a whole number from 1 to ${max}, not "${input}"`);
  }
  return n;
}

/**
 * The ref convention. An episode's `source_description` is `ref:<ref>` followed, when there is one, by
 * ` url:<url>`. The ref is percent-encoded (encodeURIComponent) so it never holds a space; the url is a
 * parsed http(s) URL, which never does either. Anything else in the description is ignored when read back.
 */
export function formatSource(ref: string, url?: string): string {
  return `ref:${encodeURIComponent(ref)}${url ? ` url:${url}` : ''}`;
}

export function parseSource(description: string | null | undefined): MemorySource {
  const text = description ?? '';
  const ref = /(?:^|\s)ref:(\S+)/.exec(text)?.[1];
  const url = /(?:^|\s)url:(\S+)/.exec(text)?.[1];
  let decoded: string | null = null;
  if (ref !== undefined) {
    try {
      decoded = decodeURIComponent(ref);
    } catch {
      decoded = ref;
    }
  }
  return { ref: decoded, url: url ?? null };
}

/** A `--url` for a document: http(s) only, returned in the form URL gives it (no spaces). */
export function parseDocumentUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CliError('INVALID_PARAMS', `--url must be an http or https link, not "${input}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('INVALID_PARAMS', `--url must be an http or https link, not "${input}"`);
  }
  return url.href;
}

/** The server stores a message as `role(role_type): content`; this gives the content back. */
export function stripSpeaker(content: string): string {
  return content.replace(/^[^\n()]*\((?:user|assistant|system)\): /, '');
}

export function toMemoryEpisode(episode: GraphitiEpisode): MemoryEpisode {
  return {
    uuid: episode.uuid,
    name: episode.name,
    group: episode.group_id,
    ...parseSource(episode.source_description),
    text: stripSpeaker(episode.content ?? ''),
    created_at: episode.created_at,
    valid_at: episode.valid_at ?? null,
    source_description: episode.source_description ?? '',
  };
}

interface RequestOptions {
  body?: unknown;
  /** Safe to send again after a network error or a 502/503/504. */
  retry?: boolean;
}

export class MemoryClient implements ServiceClient {
  readonly baseUrl: string;
  readonly defaultGroup: string | undefined;
  private readonly token: string;

  constructor(credentials: MemoryCredentials) {
    this.baseUrl = credentials.baseUrl.replace(/\/+$/, '');
    this.token = credentials.token;
    this.defaultGroup = credentials.defaultGroup || undefined;
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.health();
      return { valid: true, info: this.baseUrl };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** `--group`, else the profile's default group, else an error naming both. */
  group(given: string | undefined): string {
    if (given !== undefined) return parseGroup(given);
    if (this.defaultGroup) return this.defaultGroup;
    throw new CliError('INVALID_PARAMS', 'No group given and the profile has no default group',
      'Pass --group <id>, or add the profile again with --group <id>');
  }

  /** The groups a search covers: every `--group`, else the default group, else all groups (null). */
  groups(given: string[] | undefined): string[] | null {
    if (given && given.length) return [...new Set(given.map((g) => parseGroup(g)))];
    return this.defaultGroup ? [this.defaultGroup] : null;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const attempts = options.retry ? RETRIES + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt < attempts) {
          await Bun.sleep(retryPolicy.delayMs(attempt));
          continue;
        }
        throw new CliError('NETWORK_ERROR', `Cannot reach the Graphiti server at ${this.baseUrl}`,
          'Check the profile URL, your network, and that the server is running');
      }
      if ([502, 503, 504].includes(response.status) && attempt < attempts) {
        await response.text().catch(() => '');
        await Bun.sleep(retryPolicy.delayMs(attempt));
        continue;
      }
      const text = await response.text().catch(() => '');
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // Not JSON, such as the proxy's own error page: the status alone decides.
        }
      }
      if (response.ok) {
        if (data === null) throw new CliError('API_ERROR', `The Graphiti server at ${this.baseUrl} did not answer with JSON`, 'Check the profile URL');
        return data as T;
      }
      throw this.errorFor(response.status, data ?? plainText(text));
    }
  }

  /** The CLI error for a failed answer: FastAPI's `{ detail }`, a string or a list of validation errors. */
  private errorFor(status: number, data: unknown): CliError {
    const detail = describeDetail(data);
    const message = detail ? this.clean(detail) : undefined;
    switch (status) {
      case 401:
      case 403:
        return new CliError('AUTH_FAILED', `The Graphiti server at ${this.baseUrl} refused the token`,
          'Check the proxy\'s bearer token, then run: agentio memory profile add');
      case 404:
        return new CliError('NOT_FOUND', message ?? `Not found on the Graphiti server at ${this.baseUrl}`,
          'Check the profile URL, and the id (see: agentio memory episodes)');
      case 400:
      case 422:
        return new CliError('INVALID_PARAMS', `The Graphiti server refused the request: ${message ?? 'invalid request'}`);
      case 429:
        return new CliError('RATE_LIMITED', 'The Graphiti server is rate limiting requests', 'Wait a little and retry');
    }
    return new CliError('API_ERROR', message ? `Graphiti server error: ${message}` : `The Graphiti server answered ${status}`,
      status >= 500 ? 'The server or its LLM provider failed; retry, or check the server logs' : undefined);
  }

  /** A server message fit to show: never the token. */
  private clean(message: string): string {
    return this.token ? message.split(this.token).join('[token]') : message;
  }

  /** `GET /healthcheck`: is this a Graphiti server, and does the proxy take the token? */
  async health(): Promise<void> {
    const data = await this.request<{ status?: unknown }>('GET', '/healthcheck', { retry: true });
    if (data?.status !== 'healthy') {
      throw new CliError('CONFIG_ERROR', `${this.baseUrl} does not look like a Graphiti server`, 'Check the URL: GET /healthcheck should answer {"status":"healthy"}');
    }
  }

  /**
   * One episode, through `POST /messages`. The uuid is chosen here so the episode can be named and found
   * again; the server only answers 202 and extracts facts later, in its own queue. Not retried: a retry after
   * an answer that was lost would queue the text a second time.
   */
  async add(input: MemoryAddInput): Promise<MemoryAdded> {
    const text = input.text.trim();
    if (!text) throw new CliError('INVALID_PARAMS', 'Nothing to remember', 'Pass --text, or pipe the text on stdin');
    const ref = input.ref.trim();
    if (!ref) throw new CliError('INVALID_PARAMS', '--ref cannot be empty');
    const uuid = crypto.randomUUID();
    const name = input.name?.trim() || `ref:${ref}`;
    const sourceDescription = formatSource(ref, input.url);
    const message: Record<string, unknown> = {
      uuid,
      name,
      content: text,
      role_type: 'user',
      role: null,
      source_description: sourceDescription,
    };
    if (input.time) message.timestamp = input.time;
    await this.request('POST', '/messages', { body: { group_id: input.group, messages: [message] } });
    return { uuid, name, group: input.group, ref, url: input.url ?? null, source_description: sourceDescription, queued: true };
  }

  /** `POST /search`: facts for a query; `groups` null searches every group. */
  async search(query: string, groups: string[] | null, maxFacts: number): Promise<GraphitiFact[]> {
    if (!query.trim()) throw new CliError('INVALID_PARAMS', 'A search query is required');
    const data = await this.request<{ facts?: GraphitiFact[] }>('POST', '/search', {
      body: { group_ids: groups, query, max_facts: maxFacts },
      retry: true,
    });
    return (data.facts ?? []).map(normaliseFact);
  }

  /** `POST /get-memory`: facts ranked around one node of one group. */
  async around(group: string, centerNode: string, query: string, maxFacts: number): Promise<GraphitiFact[]> {
    const data = await this.request<{ facts?: GraphitiFact[] }>('POST', '/get-memory', {
      body: {
        group_id: group,
        max_facts: maxFacts,
        center_node_uuid: centerNode,
        messages: [{ content: query, role_type: 'user', role: null }],
      },
      retry: true,
    });
    return (data.facts ?? []).map(normaliseFact);
  }

  /** `GET /episodes/{group}`: the `lastN` most recent episodes of a group, newest first. */
  async episodes(group: string, lastN: number): Promise<GraphitiEpisode[]> {
    const data = await this.request<GraphitiEpisode[]>('GET', `/episodes/${encodeURIComponent(group)}?last_n=${lastN}`, { retry: true });
    if (!Array.isArray(data)) throw new CliError('API_ERROR', 'The Graphiti server did not answer with a list of episodes');
    return data;
  }

  async fact(uuid: string): Promise<GraphitiFact> {
    return normaliseFact(await this.request<GraphitiFact>('GET', `/entity-edge/${encodeURIComponent(uuid)}`, { retry: true }));
  }

  async deleteFact(uuid: string): Promise<void> {
    await this.request('DELETE', `/entity-edge/${encodeURIComponent(uuid)}`, { retry: true });
  }

  async deleteEpisode(uuid: string): Promise<void> {
    await this.request('DELETE', `/episode/${encodeURIComponent(uuid)}`, { retry: true });
  }
}

function normaliseFact(fact: GraphitiFact): GraphitiFact {
  return { ...fact, episodes: Array.isArray(fact.episodes) ? fact.episodes : [] };
}

/** A short plain-text error body (the server answers some 500s as text), as `{ detail }`; an HTML page is not shown. */
function plainText(text: string): { detail: string } | null {
  const line = text.trim().replace(/\s+/g, ' ');
  if (!line || line.startsWith('<')) return null;
  return { detail: line.length > 300 ? `${line.slice(0, 300)}…` : line };
}

function describeDetail(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const detail = (data as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      const item = d as { loc?: unknown[]; msg?: unknown };
      const where = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body').join('.') : '';
      return `${where ? `${where}: ` : ''}${typeof item.msg === 'string' ? item.msg : 'invalid'}`;
    });
    return parts.length ? parts.join('; ') : undefined;
  }
  return undefined;
}
