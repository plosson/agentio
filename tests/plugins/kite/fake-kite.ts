/**
 * An in-process Kite server for tests, on 127.0.0.1 with a random port. It
 * answers every route the plugin uses with Kite's status codes and error
 * envelope, as docs/plans/kite-service-integration.md §3–4 states them. The
 * opt-in contract test keeps it honest against a real Kite.
 */

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

interface Device {
  deviceCode: string;
  userCode: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'claimed';
  email?: string;
  polls: number;
  approveAfterPolls?: number;
}

interface Doc {
  id: string;
  slug: string;
  owner: string;
  type: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  isPublic: boolean;
  expiresAt: string | null;
  people: Array<{ id: string; email: string; pending: boolean; createdAt: string }>;
  domains: Array<{ id: string; domain: string; createdAt: string }>;
}

interface Thread {
  id: string;
  docId: string;
  author: string;
  status: 'open' | 'resolved';
  anchor: unknown;
  createdAt: string;
  resolvedAt: string | null;
  comments: Array<{ id: string; author: string; body: string; createdAt: string }>;
}

type Canned = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

const PUBLIC_PROVIDERS = new Set(['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com']);

export class FakeKite {
  readonly log: LoggedRequest[] = [];
  /** Tokens the server accepts, and whose they are. */
  readonly tokens = new Map<string, string>();
  readonly devices = new Map<string, Device>();
  readonly docs = new Map<string, Doc>();
  readonly threads = new Map<string, Thread>();
  maxBytes = 5 * 1024 * 1024;
  intervalSeconds = 2;
  expiresInSeconds = 600;
  /** Where the start answer sends the browser; defaults to this server. */
  verificationOrigin?: string;
  /** Applied to the next device started. */
  nextDeviceApproval?: { afterPolls: number; email: string };

  private server: ReturnType<typeof Bun.serve>;
  private queued: Canned[] = [];
  private hooks: Array<{ match: (r: LoggedRequest) => boolean; run: () => void }> = [];
  private delayMs = 0;
  private seq = 0;
  private clock = Date.parse('2026-01-01T00:00:00Z');

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => this.handle(req),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  // --- Controls

  /** A signed-in user with a CLI token; returns the token. */
  issueToken(email: string): string {
    const token = `cli_${email.replace(/\W/g, '')}_${++this.seq}`;
    this.tokens.set(token, email);
    return token;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  approve(userCode: string, email: string): void {
    const d = [...this.devices.values()].find((x) => x.userCode === userCode);
    if (d && d.state === 'pending') Object.assign(d, { state: 'approved', email });
  }

  deny(userCode: string): void {
    const d = [...this.devices.values()].find((x) => x.userCode === userCode);
    if (d) d.state = 'denied';
  }

  expire(userCode: string): void {
    const d = [...this.devices.values()].find((x) => x.userCode === userCode);
    if (d) d.state = 'expired';
  }

  /** The next request, whatever it is, gets this answer instead. */
  failNext(status: number, body?: unknown, headers?: Record<string, string>): void {
    this.queued.push({ status, body, headers });
  }

  /** Like failNext, with a body that is not JSON. */
  failNextText(status: number, text: string, headers?: Record<string, string>): void {
    this.queued.push({ status, text, headers });
  }

  rateLimitNext(seconds: number): void {
    this.failNext(429, { error: { code: 'rate_limited', message: 'Too many requests.' } }, { 'Retry-After': String(seconds) });
  }

  delay(ms: number): void {
    this.delayMs = ms;
  }

  /** Run `fn` once, right after the first request that matches has been answered. */
  after(match: (r: LoggedRequest) => boolean, fn: () => void): void {
    this.hooks.push({ match, run: fn });
  }

  /** Create a document directly, owned by `email`. */
  seedDoc(email: string, fields: Partial<Doc> = {}): Doc {
    const doc = this.newDoc(email, fields.type ?? 'markdown', fields.content ?? '# Hello', fields.title ?? 'Hello');
    Object.assign(doc, fields);
    this.docs.set(doc.id, doc);
    return doc;
  }

  requests(method?: string, pathPrefix?: string): LoggedRequest[] {
    return this.log.filter((r) => (!method || r.method === method) && (!pathPrefix || r.path.startsWith(pathPrefix)));
  }

  // --- Server

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private id(prefix: string): string {
    return `${prefix}_${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  private newDoc(owner: string, type: string, content: string, title: string): Doc {
    const at = this.now();
    return {
      id: this.id('art'), slug: this.id('s').replace('_', ''), owner, type, title, content, version: 1,
      createdAt: at, updatedAt: at, isPublic: false, expiresAt: null, people: [], domains: [],
    };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawBody = await req.text();
    let body: unknown = undefined;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const entry: LoggedRequest = {
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body, rawBody,
    };
    this.log.push(entry);
    if (this.delayMs) await Bun.sleep(this.delayMs);

    let response: Response;
    const canned = this.queued.shift();
    if (canned) {
      response = canned.text !== undefined
        ? new Response(canned.text, { status: canned.status, headers: canned.headers })
        : json(canned.status, canned.body, canned.headers);
    } else {
      response = this.route(entry);
    }
    const i = this.hooks.findIndex((h) => h.match(entry));
    if (i !== -1) this.hooks.splice(i, 1)[0].run();
    return response;
  }

  private route(r: LoggedRequest): Response {
    const { method, path } = r;
    const b = (r.body ?? {}) as Record<string, any>;

    if (method === 'POST' && path === '/api/auth/device') return this.deviceStart(b);
    if (method === 'POST' && path === '/api/auth/device/token') return this.devicePoll(b);

    const bearer = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1];
    const me = bearer ? this.tokens.get(bearer) : undefined;
    if (!me) return err(401, 'unauthenticated', 'Your session has ended. Start the Kite sign-in again.');

    if (method === 'GET' && path === '/api/auth/me') {
      return json(200, { id: `usr_${me}`, email: me, displayName: me.split('@')[0], createdAt: '2025-01-01T00:00:00Z', connectedApps: [] });
    }
    if (path === '/api/artifacts') {
      if (method === 'GET') {
        const mine = [...this.docs.values()].filter((d) => d.owner === me).reverse();
        return json(200, { artifacts: mine.map((d) => this.view(d, false)) });
      }
      if (method === 'POST') return this.publish(me, b);
    }
    let m = /^\/api\/artifacts\/by-slug\/([^/]+)$/.exec(path);
    if (m && method === 'GET') {
      const doc = [...this.docs.values()].find((d) => d.slug === decodeURIComponent(m![1]));
      if (!doc || !this.canRead(doc, me)) return err(404, 'not_found', 'No such artifact.');
      if (this.expired(doc)) return err(410, 'gone', 'This artifact link has expired.', { expiredAt: doc.expiresAt });
      return json(200, { ...this.view(doc, true), ownerName: doc.owner.split('@')[0], ownerEmail: doc.owner, youMay: { comment: true } });
    }
    m = /^\/api\/artifacts\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const doc = this.docs.get(decodeURIComponent(m[1]));
      const rest = m[2] ?? '';
      if (rest === '/comments') return this.comments(doc, me, r, b);
      if (!doc || doc.owner !== me) return err(404, 'not_found', 'No such artifact.');
      if (rest === '') return this.document(doc, method, r, b);
      if (rest.startsWith('/sharing')) return this.sharing(doc, method, rest.slice('/sharing'.length), b);
    }
    m = /^\/api\/comments\/threads\/([^/]+)\/(replies|status)$/.exec(path);
    if (m) {
      const thread = this.threads.get(decodeURIComponent(m[1]));
      const doc = thread && this.docs.get(thread.docId);
      if (!thread || !doc || !this.canRead(doc, me)) return err(404, 'not_found', 'No such thread.');
      if (m[2] === 'replies' && method === 'POST') {
        if (typeof b.body !== 'string' || !b.body.trim()) return err(400, 'validation_failed', 'Comment body is required.');
        const c = { id: this.id('cmt'), author: me, body: b.body, createdAt: this.now() };
        thread.comments.push(c);
        return json(201, { ...this.commentView(c), mentions: { notified: [], shared: [], awaitingAccess: [] } });
      }
      if (m[2] === 'status' && method === 'PUT') {
        if (b.status !== 'open' && b.status !== 'resolved') return err(400, 'validation_failed', 'Invalid status.');
        if (thread.author !== me && doc.owner !== me) return err(403, 'forbidden', 'Only the thread author or the artifact owner may do this.');
        thread.status = b.status;
        thread.resolvedAt = b.status === 'resolved' ? this.now() : null;
        return json(200, this.threadView(thread));
      }
    }
    return err(404, 'not_found', 'Not found.');
  }

  private deviceStart(b: Record<string, any>): Response {
    if (typeof b.label !== 'string' || b.label.length > 80) return err(400, 'validation_failed', 'Invalid label.');
    const d: Device = { deviceCode: this.id('dev'), userCode: `CODE-${++this.seq}`, state: 'pending', polls: 0 };
    if (this.nextDeviceApproval) {
      d.approveAfterPolls = this.nextDeviceApproval.afterPolls;
      d.email = this.nextDeviceApproval.email;
      this.nextDeviceApproval = undefined;
    }
    this.devices.set(d.deviceCode, d);
    return json(200, {
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      verificationUrl: `${this.verificationOrigin ?? this.url}/auth/device?code=${d.userCode}`,
      expiresInSeconds: this.expiresInSeconds,
      intervalSeconds: this.intervalSeconds,
    });
  }

  private devicePoll(b: Record<string, any>): Response {
    const d = this.devices.get(b.deviceCode);
    if (!d || d.state === 'claimed') return err(401, 'unauthenticated', 'Unknown or used sign-in code. Start the Kite sign-in again.');
    d.polls++;
    if (d.state === 'pending' && d.approveAfterPolls !== undefined && d.polls >= d.approveAfterPolls) d.state = 'approved';
    switch (d.state) {
      case 'pending': return json(202, { state: 'pending' });
      case 'denied': return json(403, { state: 'denied' });
      case 'expired': return json(410, { state: 'expired' });
      default: {
        d.state = 'claimed';
        const token = this.issueToken(d.email!);
        return json(200, { state: 'approved', token, expiresAt: '2026-04-01T00:00:00Z' });
      }
    }
  }

  private publish(me: string, b: Record<string, any>): Response {
    if (b.type !== 'markdown' && b.type !== 'html') return err(400, 'unsupported_type', 'Only markdown and html artifacts are supported.');
    if (typeof b.content !== 'string' || b.content.length === 0) return err(400, 'validation_failed', 'Artifact content must not be empty.');
    if (Buffer.byteLength(b.content) > this.maxBytes) return err(413, 'payload_too_large', 'Artifact too large.', { maxBytes: this.maxBytes });
    const doc = this.newDoc(me, b.type, b.content, typeof b.title === 'string' ? b.title : 'Untitled');
    this.docs.set(doc.id, doc);
    return json(201, this.view(doc, true));
  }

  private document(doc: Doc, method: string, r: LoggedRequest, b: Record<string, any>): Response {
    if (method === 'GET') {
      if (this.expired(doc)) return err(410, 'gone', 'This artifact link has expired.', { expiredAt: doc.expiresAt });
      return json(200, this.view(doc, true));
    }
    if (method === 'PUT') {
      if (b.type !== 'markdown' && b.type !== 'html') return err(400, 'unsupported_type', 'Only markdown and html artifacts are supported.');
      if (typeof b.content !== 'string' || b.content.length === 0) return err(400, 'validation_failed', 'Artifact content must not be empty.');
      if (Buffer.byteLength(b.content) > this.maxBytes) return err(413, 'payload_too_large', 'Artifact too large.', { maxBytes: this.maxBytes });
      if (b.baseVersion !== doc.version) {
        return err(409, 'version_conflict', 'The artifact changed.', { currentVersion: doc.version, baseVersion: b.baseVersion });
      }
      Object.assign(doc, { type: b.type, content: b.content, version: doc.version + 1, updatedAt: this.now() });
      if (typeof b.title === 'string') doc.title = b.title;
      return json(200, this.view(doc, true));
    }
    if (method === 'DELETE') {
      if (r.query.confirm !== 'true') return err(400, 'validation_failed', 'Pass confirm=true to delete an artifact.');
      this.docs.delete(doc.id);
      return new Response(null, { status: 204 });
    }
    return err(404, 'not_found', 'Not found.');
  }

  private sharing(doc: Doc, method: string, rest: string, b: Record<string, any>): Response {
    const state = () => ({
      artifactId: doc.id, isPublic: doc.isPublic, people: doc.people, domains: doc.domains, expiresAt: doc.expiresAt,
    });
    if (rest === '' && method === 'GET') return json(200, state());
    if (rest === '/people' && method === 'POST') {
      if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(b.email)) return err(400, 'validation_failed', 'Invalid email.');
      if (doc.people.some((p) => p.email === b.email)) return json(200, { ...state(), notified: false });
      doc.people.push({ id: this.id('shr'), email: b.email, pending: true, createdAt: this.now() });
      return json(201, { ...state(), notified: true });
    }
    if (rest === '/domains' && method === 'POST') {
      if (typeof b.domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(b.domain)) return err(400, 'validation_failed', 'Invalid domain.');
      if (PUBLIC_PROVIDERS.has(b.domain.toLowerCase())) return err(400, 'validation_failed', `${b.domain} is a public email provider and cannot be shared with.`);
      if (doc.domains.some((d) => d.domain === b.domain)) return json(200, state());
      doc.domains.push({ id: this.id('dom'), domain: b.domain, createdAt: this.now() });
      return json(201, state());
    }
    let m = /^\/people\/(.+)$/.exec(rest);
    if (m && method === 'DELETE') {
      const email = decodeURIComponent(m[1]);
      const i = doc.people.findIndex((p) => p.email === email);
      if (i === -1) return err(404, 'not_found', 'Not shared with that person.');
      doc.people.splice(i, 1);
      return json(200, state());
    }
    m = /^\/domains\/(.+)$/.exec(rest);
    if (m && method === 'DELETE') {
      const domain = decodeURIComponent(m[1]);
      const i = doc.domains.findIndex((d) => d.domain === domain);
      if (i === -1) return err(404, 'not_found', 'Not shared with that domain.');
      doc.domains.splice(i, 1);
      return json(200, state());
    }
    if (rest === '/public' && method === 'PUT') {
      if (typeof b.isPublic !== 'boolean') return err(400, 'validation_failed', 'isPublic must be a boolean.');
      doc.isPublic = b.isPublic;
      return json(200, state());
    }
    if (rest === '/expiry' && method === 'PUT') {
      const m2 = /^(\d+)([hd])$/.exec(String(b.expiresIn));
      if (b.expiresIn === 'forever') doc.expiresAt = null;
      else if (m2) doc.expiresAt = new Date(this.clock + Number(m2[1]) * (m2[2] === 'h' ? 3600e3 : 86400e3)).toISOString();
      else return err(400, 'validation_failed', 'Invalid expiresIn.');
      return json(200, state());
    }
    return err(404, 'not_found', 'Not found.');
  }

  private comments(doc: Doc | undefined, me: string, r: LoggedRequest, b: Record<string, any>): Response {
    if (!doc || !this.canRead(doc, me)) return err(404, 'not_found', 'No such artifact.');
    if (r.method === 'GET') {
      if (r.query.status && r.query.status !== 'open' && r.query.status !== 'resolved') return err(400, 'validation_failed', 'Invalid status.');
      const since = r.query.since ? Date.parse(r.query.since) : undefined;
      if (since !== undefined && isNaN(since)) return err(400, 'validation_failed', 'Invalid since.');
      const threads = [...this.threads.values()]
        .filter((t) => t.docId === doc.id)
        .filter((t) => !r.query.status || t.status === r.query.status)
        .filter((t) => since === undefined || Date.parse(t.comments[t.comments.length - 1].createdAt) > since);
      return json(200, { threads: threads.map((t) => this.threadView(t)) });
    }
    if (r.method === 'POST') {
      if (typeof b.body !== 'string' || !b.body.trim()) return err(400, 'validation_failed', 'Comment body is required.');
      const pos = b.position as Record<string, unknown> | undefined;
      if (pos?.snippet !== undefined && (typeof pos.snippet !== 'string' || pos.snippet.length < 8 || pos.snippet.length > 2000)) {
        return err(400, 'validation_failed', 'The snippet must be 8 to 2000 characters of the rendered artifact.');
      }
      const at = this.now();
      const t: Thread = {
        id: this.id('thr'), docId: doc.id, author: me, status: 'open', anchor: pos ?? null, createdAt: at, resolvedAt: null,
        comments: [{ id: this.id('cmt'), author: me, body: b.body, createdAt: at }],
      };
      this.threads.set(t.id, t);
      return json(201, { ...this.threadView(t), mentions: { notified: [], shared: [], awaitingAccess: [] } });
    }
    return err(404, 'not_found', 'Not found.');
  }

  private canRead(doc: Doc, me: string): boolean {
    return doc.owner === me || doc.isPublic || doc.people.some((p) => p.email === me);
  }

  private expired(doc: Doc): boolean {
    return doc.expiresAt !== null && Date.parse(doc.expiresAt) < this.clock;
  }

  private view(doc: Doc, withContent: boolean) {
    const { content, owner, people, domains, ...rest } = doc;
    return {
      ...rest, ownerId: `usr_${owner}`, isPublic: doc.isPublic ? 1 : 0, url: `${this.url}/a/${doc.slug}`,
      ...(withContent ? { content } : {}),
    };
  }

  private commentView(c: Thread['comments'][number]) {
    return { id: c.id, author: { email: c.author, displayName: c.author.split('@')[0] }, body: c.body, createdAt: c.createdAt, deleted: false };
  }

  private threadView(t: Thread) {
    return {
      id: t.id, status: t.status, anchor: t.anchor, anchorLost: false, anchorDrifted: false,
      createdAt: t.createdAt, resolvedAt: t.resolvedAt, comments: t.comments.map((c) => this.commentView(c)),
    };
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function err(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}
