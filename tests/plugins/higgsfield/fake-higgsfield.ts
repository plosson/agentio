/**
 * A small Higgsfield API on a local Bun.serve: uploads (with a presigned PUT), submissions that honour
 * Idempotency-Key, status, cancel, delete, estimate and output files. Shapes follow docs.higgsfield.ai.
 */
export interface FakeOptions {
  key?: string;
  /** Answers 429 account_queue_full to this many submissions first. */
  queueFullTimes?: number;
  /** How a submitted request ends: its final status and output fields, after `steps` status checks. */
  outcome?: { status: string; error?: string; steps?: number; output?: Record<string, unknown> };
}

export interface Logged { method: string; path: string; headers: Record<string, string>; body?: unknown }

export class FakeHiggsfield {
  readonly url: string;
  readonly log: Logged[] = [];
  readonly stored = new Map<string, Uint8Array>();
  readonly requests = new Map<string, { idem: string; body: unknown; checks: number; status: string; deleted?: boolean }>();
  private readonly server: ReturnType<typeof Bun.serve>;
  private queueFull: number;
  private next = 1;

  constructor(private readonly options: FakeOptions = {}) {
    this.queueFull = options.queueFullTimes ?? 0;
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
    this.url = `http://localhost:${this.server.port}`;
  }

  stop(): void { this.server.stop(true); }

  private id(): string { return `00000000-0000-4000-8000-${String(this.next++).padStart(12, '0')}`; }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const headers = Object.fromEntries(req.headers.entries());
    if (req.method === 'PUT' && path.startsWith('/storage/')) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      this.log.push({ method: 'PUT', path, headers });
      if (headers['x-amz-tagging'] !== 'retention=temporary') return new Response('missing header', { status: 403 });
      this.stored.set(path.slice('/storage/'.length), bytes);
      return new Response(null, { status: 200 });
    }
    if (req.method === 'GET' && path.startsWith('/cdn/')) {
      this.log.push({ method: 'GET', path, headers });
      return new Response(`output ${path}`);
    }
    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : undefined;
    this.log.push({ method: req.method, path, headers, body });
    if (headers.authorization !== `Key ${this.options.key ?? 'kid:ksecret'}`) return Response.json({ detail: 'Invalid credentials' }, { status: 401 });

    if (path === '/files/generate-upload-url') {
      const name = `${this.next++}`;
      return Response.json({
        public_url: `${this.url}/cdn/input/${name}`,
        upload_url: `${this.url}/storage/${name}`,
        content_type: body.content_type,
        upload_headers: { 'Content-Type': body.content_type, 'x-amz-tagging': 'retention=temporary' },
      });
    }
    if (path.startsWith('/estimate/')) {
      if (path.includes('genjutsu')) return Response.json({ pricing_description: 'Each second of input video costs $0.318 at 480p' });
      return Response.json({ usd: '0.094' });
    }
    const status = path.match(/^\/requests\/([^/]+)\/status$/);
    if (status) {
      const r = this.requests.get(status[1]);
      if (!r || r.deleted) return Response.json({ detail: 'Request not found' }, { status: 404 });
      const outcome = this.options.outcome ?? { status: 'completed', output: { images: [{ url: `${this.url}/cdn/out/a.png` }, { url: `${this.url}/cdn/out/b.png` }] } };
      r.checks++;
      if (r.status === 'canceled') return Response.json({ request_id: status[1], status: 'canceled' });
      if (r.checks <= (outcome.steps ?? 1)) return Response.json({ request_id: status[1], status: r.checks === 1 ? 'queued' : 'in_progress' });
      r.status = outcome.status;
      return Response.json({ request_id: status[1], status: outcome.status, error: outcome.error ?? null, expires_at: '2026-11-05T12:00:00Z', status_url: 'x', ...(outcome.status === 'completed' ? outcome.output : {}) });
    }
    const cancel = path.match(/^\/requests\/([^/]+)\/cancel$/);
    if (cancel) {
      const r = this.requests.get(cancel[1]);
      if (!r) return Response.json({ detail: 'Request not found' }, { status: 404 });
      if (r.checks > 0) return Response.json({ detail: 'Request already started' }, { status: 400 });
      r.status = 'canceled';
      return new Response(null, { status: 202 });
    }
    const del = path.match(/^\/requests\/([^/]+)$/);
    if (del && req.method === 'DELETE') {
      const r = this.requests.get(del[1]);
      if (!r) return Response.json({ detail: 'Request not found' }, { status: 404 });
      if (r.status === 'queued') return Response.json({ detail: 'Request is still running' }, { status: 409 });
      r.deleted = true;
      return Response.json({ request_id: del[1], status: 'deleted' });
    }
    if (req.method === 'POST') {
      if (this.queueFull > 0) {
        this.queueFull--;
        return Response.json({ detail: { code: 'account_queue_full', message: 'Too many queued generations for this account', retryable: true, limit: 40, retry_after_seconds: 0 } }, { status: 429, headers: { 'Retry-After': '0' } });
      }
      if (body?.prompt === '') return Response.json({ detail: [{ loc: ['body', 'prompt'], msg: 'String should have at least 1 character' }] }, { status: 422 });
      const idem = headers['idempotency-key'] ?? '';
      for (const [id, r] of this.requests) if (idem && r.idem === idem) return Response.json({ status: 'queued', request_id: id });
      const id = this.id();
      this.requests.set(id, { idem, body, checks: 0, status: 'queued' });
      return Response.json({ status: 'queued', request_id: id, status_url: `${this.url}/requests/${id}/status`, cancel_url: `${this.url}/requests/${id}/cancel` });
    }
    return Response.json({ detail: 'Not Found' }, { status: 404 });
  }
}
