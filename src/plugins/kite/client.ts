import { readFile, stat } from 'fs/promises';
import { extname } from 'path';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import type {
  KiteCommentPosition,
  KiteCredentials,
  KiteDocument,
  KiteDocumentType,
  KiteMe,
  KiteRawComment,
  KiteRawDocument,
  KiteRawSharingState,
  KiteRawThread,
  KiteSharing,
  KiteReply,
  KiteThread,
} from './types';

/**
 * Kite's REST API. Kite is a fork of Open Artifact, so the server says
 * "artifact" in its routes and some messages; nothing this client shows says
 * it (see `sanitise`), because agents confuse the word with their own tool.
 */

const REAUTH = 'Run: agentio profile reauth kite';
const REQUEST_TIMEOUT_MS = 30_000;

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

/** "artifact" → "document", whole word, keeping its case. `artifactId` is left alone. */
export function sanitise(message: string): string {
  return message.replace(/\b(artifact)(s?)\b/gi, (_m, word: string, plural: string) => {
    const doc = word === word.toUpperCase() ? 'DOCUMENT' : word[0] === 'A' ? 'Document' : 'document';
    return doc + (plural ? (plural === 'S' ? 'S' : 's') : '');
  });
}

/** Scheme required (https added when absent), http(s) only, no path, no trailing slash. */
export function normaliseBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CliError('INVALID_PARAMS', 'The Kite URL is required', 'Example: --url https://kite.example.com');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError('INVALID_PARAMS', `Not a valid Kite URL: ${input}`, 'Example: --url https://kite.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('INVALID_PARAMS', `A Kite URL must use https or http, not ${url.protocol.slice(0, -1)}`);
  }
  if (!url.hostname || url.username || url.password) {
    throw new CliError('INVALID_PARAMS', `Not a valid Kite URL: ${input}`, 'Example: --url https://kite.example.com');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** The document format from a file's extension, or INVALID_PARAMS. */
export function formatFromPath(path: string): KiteDocumentType {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.html':
    case '.htm':
      return 'html';
    default:
      throw new CliError('INVALID_PARAMS', `Kite publishes Markdown and HTML only: ${path}`,
        'Use a file ending in .md, .markdown, .html or .htm');
  }
}

/** Read a document to publish, refusing anything that is not a readable Markdown or HTML file. */
export async function readDocumentFile(path: string): Promise<{ type: KiteDocumentType; content: string }> {
  const type = formatFromPath(path);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new CliError('INVALID_PARAMS', `File not found: ${path}`);
  }
  if (info.isDirectory()) throw new CliError('INVALID_PARAMS', `${path} is a directory, not a file`);
  try {
    return { type, content: await readFile(path, 'utf8') };
  } catch {
    throw new CliError('INVALID_PARAMS', `Cannot read ${path}`);
  }
}

type KiteReference = { kind: 'id'; id: string } | { kind: 'slug'; slug: string };

/** `art_…` is an id; otherwise the text after the last `/a/`, cut at `?` or `#`, or a bare slug. */
export function resolveReference(input: string): KiteReference {
  const trimmed = input.trim();
  if (trimmed.startsWith('art_')) return { kind: 'id', id: trimmed };
  const at = trimmed.lastIndexOf('/a/');
  const tail = at === -1 ? trimmed : trimmed.slice(at + 3);
  const slug = tail.split(/[?#]/)[0].replace(/\/+$/, '');
  if (!slug || slug.includes('/') || (at === -1 && /[:?#]/.test(trimmed))) {
    throw new CliError('INVALID_PARAMS', `Not a Kite document id or link: ${input}`,
      'Pass an id (art_…) or a link like https://kite.example.com/a/<slug>');
  }
  return { kind: 'slug', slug };
}

/** Commands that change a document take its id only; a link must be looked up first. */
export function requireDocumentId(input: string): string {
  const trimmed = input.trim();
  if (/^art_[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  throw new CliError('INVALID_PARAMS', `Expected a document id (art_…), got: ${input}`,
    'Run: agentio kite get <link> --json to learn its id');
}

function requireThreadId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || /[/?#\s]/.test(trimmed)) {
    throw new CliError('INVALID_PARAMS', `Not a comment thread id: ${input}`, 'Thread ids look like thr_… (see: agentio kite comments list)');
  }
  return trimmed;
}

const MAX_EXPIRY_DAYS = 3650;

/** A sharing expiry as the server takes it: `Nh`, `Nd` or `forever`. */
export function parseDuration(input: string): string {
  const text = input.trim().toLowerCase();
  if (text === 'forever' || text === 'never' || text === 'none') return 'forever';
  const match = /^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  const refuse = () => new CliError('INVALID_PARAMS', `Not a duration: "${input}"`,
    'Use hours or days, like 12h or 30d, or forever');
  if (!match) throw refuse();
  const n = parseInt(match[1], 10);
  const days = match[2].startsWith('d');
  if (n < 1) throw refuse();
  if ((days ? n : n / 24) > MAX_EXPIRY_DAYS) {
    throw new CliError('INVALID_PARAMS', `Duration too long: "${input}"`, 'The longest expiry is 10 years; use forever for none');
  }
  return `${n}${days ? 'd' : 'h'}`;
}

/** A share target is an email when it has an `@` past the first character, else a domain. */
export function shareTarget(input: string): { kind: 'email'; value: string } | { kind: 'domain'; value: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new CliError('INVALID_PARAMS', 'An email or a domain is required');
  if (trimmed.includes('@') && !trimmed.startsWith('@')) return { kind: 'email', value: trimmed };
  const domain = trimmed.replace(/^@/, '');
  if (!domain || domain.includes('@')) throw new CliError('INVALID_PARAMS', `Not an email or a domain: ${input}`);
  return { kind: 'domain', value: domain };
}

function parseStatus(input: string): 'open' | 'resolved' {
  if (input === 'open' || input === 'resolved') return input;
  throw new CliError('INVALID_PARAMS', `--status must be open or resolved, not "${input}"`);
}

function parseSince(input: string): string {
  if (!input.trim() || isNaN(Date.parse(input))) {
    throw new CliError('INVALID_PARAMS', `--since is not a timestamp: "${input}"`, 'Use ISO 8601, like 2026-01-31T09:00:00Z');
  }
  return input.trim();
}

function requireBody(body: string | undefined): string {
  if (!body || !body.trim()) throw new CliError('INVALID_PARAMS', 'The comment text is empty', 'Pass it with --body');
  return body;
}

function toDocument(raw: KiteRawDocument): KiteDocument {
  return { id: raw.id, url: raw.url, title: raw.title, type: raw.type, version: raw.version, updated: raw.updatedAt };
}

function toSharing(raw: KiteRawSharingState): KiteSharing {
  return {
    id: raw.artifactId,
    isPublic: raw.isPublic,
    people: raw.people.map((p) => ({ email: p.email, pending: p.pending })),
    domains: raw.domains.map((d) => d.domain),
    expiresAt: raw.expiresAt,
  };
}

function toThread(raw: KiteRawThread): KiteThread {
  return {
    id: raw.id,
    status: raw.status,
    anchor: raw.anchor,
    anchorLost: raw.anchorLost,
    anchorDrifted: raw.anchorDrifted,
    comments: raw.comments.map((c) => ({ author: c.author?.email ?? null, body: c.body, createdAt: c.createdAt })),
  };
}

export interface CommentInput {
  body: string;
  snippet?: string;
  heading?: string;
  elementId?: string;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** The device flow runs before there is a token. */
  auth?: boolean;
}

interface RawResponse {
  status: number;
  headers: Headers;
  data: unknown;
}

export class KiteClient implements ServiceClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(credentials: Pick<KiteCredentials, 'baseUrl' | 'token'>) {
    this.baseUrl = credentials.baseUrl.replace(/\/+$/, '');
    this.token = credentials.token;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const me = await this.me();
      return { valid: true, info: me.email };
    } catch (error) {
      if (error instanceof CliError && error.code === 'AUTH_EXPIRED') {
        return { valid: false, error: `${error.message}. ${REAUTH}` };
      }
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** One HTTP exchange; answers any status without throwing, except when the server cannot be reached. */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CliError('NETWORK_ERROR', `Cannot reach Kite at ${this.baseUrl}`, 'Check the URL and your network connection');
    }
    const text = await response.text().catch(() => '');
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Not JSON, such as a proxy's HTML page: the status alone decides.
      }
    }
    return { status: response.status, headers: response.headers, data };
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, options);
    if (res.status >= 200 && res.status < 300) return res.data as T;
    throw this.errorFor(res);
  }

  /** The plugin's own error for a failed answer (§6.3). */
  errorFor(res: RawResponse): CliError {
    const envelope = (res.data as ErrorEnvelope | null)?.error;
    const code = typeof envelope?.code === 'string' ? envelope.code : undefined;
    const details = envelope?.details ?? {};
    const detail = typeof envelope?.message === 'string' && envelope.message.trim()
      ? this.clean(envelope.message.trim())
      : undefined;
    const withDetail = (message: string) => (detail && detail !== message ? `${message}: ${detail}` : message);

    if (res.status === 401 || code === 'unauthenticated') {
      return new CliError('AUTH_EXPIRED', `Kite at ${this.baseUrl} no longer accepts this sign-in`, REAUTH);
    }
    if (res.status === 403 || code === 'forbidden') {
      return new CliError('PERMISSION_DENIED', withDetail('Kite refused this action'),
        'Only the author of a comment thread or the owner of the document can do that');
    }
    if (res.status === 410 || code === 'gone') {
      const expiredAt = typeof details.expiredAt === 'string' ? ` on ${details.expiredAt}` : '';
      return new CliError('NOT_FOUND', `The share link expired${expiredAt}`, 'Ask the owner to share the document again');
    }
    if (res.status === 404 || code === 'not_found') {
      return new CliError('NOT_FOUND', withDetail('Not found on Kite'), 'Check the id; the document may not be yours');
    }
    if (res.status === 409 || code === 'version_conflict') {
      const now = details.currentVersion ?? '?';
      const had = details.baseVersion ?? '?';
      return new CliError('API_ERROR',
        `Someone changed this document since you read it (now version ${now}, you had ${had}). Read it again with \`kite get\` and re-apply your change.`);
    }
    if (res.status === 413 || code === 'payload_too_large') {
      const max = typeof details.maxBytes === 'number' ? ` (the limit is ${details.maxBytes} bytes)` : '';
      return new CliError('INVALID_PARAMS', `The document is too large${max}`, 'Split it or trim embedded data');
    }
    if (code === 'unsupported_type') {
      return new CliError('INVALID_PARAMS', withDetail('Kite publishes Markdown and HTML only'));
    }
    if (res.status === 429 || code === 'rate_limited') {
      const after = res.headers.get('retry-after');
      return new CliError('RATE_LIMITED', 'Kite is rate limiting this account',
        after ? `Retry after ${after} seconds` : 'Retry later');
    }
    if (res.status === 400 || code === 'validation_failed') {
      return new CliError('INVALID_PARAMS', detail ?? 'Kite refused the request as invalid');
    }
    const requestId = typeof details.requestId === 'string' ? details.requestId : res.headers.get('x-request-id');
    return new CliError('API_ERROR', withDetail(`Kite answered ${res.status}`),
      requestId ? `Request id: ${requestId}` : undefined);
  }

  /** A server message fit to show: no "artifact", and never the token. */
  private clean(message: string): string {
    const scrubbed = this.token ? message.split(this.token).join('[token]') : message;
    return sanitise(scrubbed);
  }

  me(): Promise<KiteMe> {
    return this.request<KiteMe>('GET', '/api/auth/me');
  }

  async publish(input: DocumentInput): Promise<KiteDocument> {
    return toDocument(await this.request<KiteRawDocument>('POST', '/api/artifacts', { body: documentBody(input) }));
  }

  /** Read the current version, then write against it; a change in between is a conflict, never retried. */
  async update(id: string, input: DocumentInput): Promise<KiteDocument> {
    const docId = requireDocumentId(id);
    const body = documentBody(input);
    const current = await this.request<KiteRawDocument>('GET', `/api/artifacts/${enc(docId)}`);
    body.baseVersion = current.version;
    return toDocument(await this.request<KiteRawDocument>('PUT', `/api/artifacts/${enc(docId)}`, { body }));
  }

  async get(reference: string): Promise<KiteDocument & { content: string }> {
    const ref = resolveReference(reference);
    const path = ref.kind === 'id' ? `/api/artifacts/${enc(ref.id)}` : `/api/artifacts/by-slug/${enc(ref.slug)}`;
    const raw = await this.request<KiteRawDocument>('GET', path);
    return { ...toDocument(raw), content: raw.content ?? '' };
  }

  async list(): Promise<KiteDocument[]> {
    const data = await this.request<{ artifacts: KiteRawDocument[] }>('GET', '/api/artifacts');
    return (data?.artifacts ?? []).map(toDocument);
  }

  async delete(id: string): Promise<void> {
    await this.request('DELETE', `/api/artifacts/${enc(requireDocumentId(id))}`, { query: { confirm: 'true' } });
  }

  private sharingPath(id: string, rest = ''): string {
    return `/api/artifacts/${enc(requireDocumentId(id))}/sharing${rest}`;
  }

  async sharing(id: string): Promise<KiteSharing> {
    return toSharing(await this.request<KiteRawSharingState>('GET', this.sharingPath(id)));
  }

  async share(id: string, target: string): Promise<KiteSharing & { notified: boolean }> {
    const t = shareTarget(target);
    const res = await this.raw('POST', this.sharingPath(id, `/${shareList(t)}`), { body: { [t.kind]: t.value } });
    if (res.status !== 200 && res.status !== 201) throw this.errorFor(res);
    // A new share with a person emails them; a domain share emails nobody.
    return { ...toSharing(res.data as KiteRawSharingState), notified: t.kind === 'email' && res.status === 201 };
  }

  async unshare(id: string, target: string): Promise<KiteSharing> {
    const t = shareTarget(target);
    const path = this.sharingPath(id, `/${shareList(t)}/${enc(t.value)}`);
    return toSharing(await this.request<KiteRawSharingState>('DELETE', path));
  }

  async setPublic(id: string, isPublic: boolean): Promise<KiteSharing> {
    return toSharing(await this.request<KiteRawSharingState>('PUT', this.sharingPath(id, '/public'), { body: { isPublic } }));
  }

  async setExpiry(id: string, duration: string): Promise<KiteSharing> {
    const expiresIn = parseDuration(duration);
    return toSharing(await this.request<KiteRawSharingState>('PUT', this.sharingPath(id, '/expiry'), { body: { expiresIn } }));
  }

  async comments(id: string, filter: { status?: string; since?: string } = {}): Promise<KiteThread[]> {
    const query = {
      status: filter.status !== undefined ? parseStatus(filter.status) : undefined,
      since: filter.since !== undefined ? parseSince(filter.since) : undefined,
    };
    const data = await this.request<{ threads: KiteRawThread[] }>('GET', `/api/artifacts/${enc(requireDocumentId(id))}/comments`, { query });
    return (data?.threads ?? []).map(toThread);
  }

  async comment(id: string, input: CommentInput): Promise<KiteThread & { mentions: unknown }> {
    const docId = requireDocumentId(id);
    const body: Record<string, unknown> = { body: requireBody(input.body) };
    const position = commentPosition(input);
    if (position) body.position = position;
    const data = await this.request<KiteRawThread & { mentions: unknown }>('POST', `/api/artifacts/${enc(docId)}/comments`, { body });
    return { ...toThread(data), mentions: data.mentions };
  }

  async reply(threadId: string, text: string): Promise<KiteReply> {
    const tid = requireThreadId(threadId);
    const body = requireBody(text);
    const data = await this.request<KiteRawComment & { mentions: unknown }>(
      'POST', `/api/comments/threads/${enc(tid)}/replies`, { body: { body } });
    return { id: data.id, author: data.author?.email ?? null, body: data.body, createdAt: data.createdAt, mentions: data.mentions };
  }

  async setThreadStatus(threadId: string, status: 'open' | 'resolved'): Promise<KiteThread> {
    const tid = requireThreadId(threadId);
    return toThread(await this.request<KiteRawThread>('PUT', `/api/comments/threads/${enc(tid)}/status`, { body: { status } }));
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

type DocumentInput = { type: KiteDocumentType; content: string; title?: string };

/** What publish and update both send; a blank title is refused before any request. */
function documentBody(input: DocumentInput): Record<string, unknown> {
  const body: Record<string, unknown> = { type: input.type, content: input.content };
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new CliError('INVALID_PARAMS', 'The title is empty', 'Leave out --title to keep the current one');
    body.title = input.title;
  }
  return body;
}

/** The sharing list a target belongs to, as the server names it in paths. */
function shareList(target: ReturnType<typeof shareTarget>): 'people' | 'domains' {
  return target.kind === 'email' ? 'people' : 'domains';
}

/**
 * The anchor of a new comment. Unlike the Open Artifact CLI, `headingId` is
 * sent only with `--heading`: a snippet alone is searched across the whole
 * document, as Kite documents it.
 */
export function commentPosition(input: CommentInput): KiteCommentPosition | undefined {
  if (input.heading !== undefined && input.snippet === undefined) {
    throw new CliError('INVALID_PARAMS', '--heading needs --snippet', 'The heading only narrows where the snippet is searched');
  }
  const position: KiteCommentPosition = {};
  if (input.elementId !== undefined) position.elementId = input.elementId;
  if (input.snippet !== undefined) position.snippet = input.snippet;
  if (input.heading !== undefined) position.headingId = input.heading;
  return Object.keys(position).length ? position : undefined;
}
