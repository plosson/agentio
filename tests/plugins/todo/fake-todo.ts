/**
 * In-process Todo server for plugin tests (device OAuth + REST).
 * Mirrors the plosson/todo API shape used by the plugin.
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
  headers: Record<string, string>;
  body: unknown;
}

interface Device {
  deviceCode: string;
  userCode: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'claimed';
  email?: string;
  polls: number;
  approveAfterPolls?: number;
}

interface TodoRow {
  id: string;
  title: string;
  notes: string | null;
  done: boolean;
  doneAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  owner: string;
}

type Canned = { status: number; body?: unknown };

export class FakeTodo {
  readonly log: LoggedRequest[] = [];
  readonly tokens = new Map<string, string>();
  readonly devices = new Map<string, Device>();
  readonly todos = new Map<string, TodoRow>();
  intervalSeconds = 2;
  expiresInSeconds = 600;
  verificationOrigin?: string;
  nextDeviceApproval?: { afterPolls: number; email: string };

  private server: ReturnType<typeof Bun.serve>;
  private queued: Canned[] = [];
  private seq = 0;

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

  failNext(status: number, body?: unknown): void {
    this.queued.push({ status, body });
  }

  deny(userCode: string): void {
    for (const d of this.devices.values()) {
      if (d.userCode === userCode) d.state = 'denied';
    }
  }

  expire(userCode: string): void {
    for (const d of this.devices.values()) {
      if (d.userCode === userCode) d.state = 'expired';
    }
  }

  requests(method: string, path: string): LoggedRequest[] {
    return this.log.filter((r) => r.method === method && r.path === path);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawBody = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const logged: LoggedRequest = { method: req.method, path: url.pathname, headers, body };
    this.log.push(logged);

    if (this.queued.length) {
      const c = this.queued.shift()!;
      return Response.json(c.body ?? { error: 'unauthenticated', message: 'fail' }, { status: c.status });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/device') {
      const deviceCode = `dc_${++this.seq}_${crypto.randomUUID()}`;
      const userCode = `ABCD-${String(this.seq).padStart(4, '0')}`;
      const device: Device = {
        deviceCode,
        userCode,
        state: 'pending',
        polls: 0,
        approveAfterPolls: this.nextDeviceApproval?.afterPolls,
        email: this.nextDeviceApproval?.email,
      };
      this.devices.set(deviceCode, device);
      this.nextDeviceApproval = undefined;
      const origin = this.verificationOrigin ?? this.url;
      return Response.json({
        deviceCode,
        userCode,
        verificationUrl: `${origin}/auth/device?code=${encodeURIComponent(userCode)}`,
        expiresInSeconds: this.expiresInSeconds,
        intervalSeconds: this.intervalSeconds,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/device/token') {
      const deviceCode = (body as { deviceCode?: string })?.deviceCode;
      const device = deviceCode ? this.devices.get(deviceCode) : undefined;
      if (!device) return Response.json({ error: 'unauthenticated', message: 'unknown' }, { status: 401 });
      device.polls += 1;
      if (device.approveAfterPolls !== undefined && device.polls >= device.approveAfterPolls && device.state === 'pending') {
        device.state = 'approved';
      }
      if (device.state === 'pending') return Response.json({ state: 'pending' }, { status: 202 });
      if (device.state === 'denied') return Response.json({ state: 'denied' }, { status: 403 });
      if (device.state === 'expired') return Response.json({ state: 'expired' }, { status: 410 });
      if (device.state === 'claimed') return Response.json({ error: 'unauthenticated', message: 'already claimed' }, { status: 401 });
      device.state = 'claimed';
      const token = `tok_${++this.seq}`;
      const email = device.email ?? 'me@example.com';
      this.tokens.set(token, email);
      return Response.json({ state: 'approved', token, expiresAt: '2026-04-01T00:00:00Z' });
    }

    const auth = headers.authorization?.replace(/^Bearer\s+/i, '');
    const email = auth ? this.tokens.get(auth) : undefined;

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!email) return Response.json({ error: 'unauthenticated', message: 'sign in' }, { status: 401 });
      return Response.json({ id: 'usr_1', email, displayName: 'Test', createdAt: '2026-01-01T00:00:00Z' });
    }

    if (req.method === 'GET' && url.pathname === '/api/todos') {
      if (!email) return Response.json({ error: 'unauthenticated', message: 'sign in' }, { status: 401 });
      const status = url.searchParams.get('status') ?? 'open';
      const tag = url.searchParams.get('tag');
      let list = [...this.todos.values()].filter((t) => t.owner === email);
      if (status === 'open') list = list.filter((t) => !t.done);
      if (status === 'done') list = list.filter((t) => t.done);
      if (tag) list = list.filter((t) => t.tags.includes(tag));
      return Response.json({ todos: list.map(publicTodo) });
    }

    if (req.method === 'POST' && url.pathname === '/api/todos') {
      if (!email) return Response.json({ error: 'unauthenticated', message: 'sign in' }, { status: 401 });
      const b = body as { title?: string; tags?: string[]; notes?: string };
      if (!b.title?.trim()) return Response.json({ error: 'validation_failed', message: 'title required' }, { status: 400 });
      const now = new Date().toISOString();
      const row: TodoRow = {
        id: `tod_${++this.seq}`,
        title: b.title.trim(),
        notes: b.notes ?? null,
        done: false,
        doneAt: null,
        tags: b.tags ?? [],
        createdAt: now,
        updatedAt: now,
        owner: email,
      };
      this.todos.set(row.id, row);
      return Response.json(publicTodo(row), { status: 201 });
    }

    const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)(?:\/(check|uncheck))?$/);
    if (todoMatch) {
      if (!email) return Response.json({ error: 'unauthenticated', message: 'sign in' }, { status: 401 });
      const id = decodeURIComponent(todoMatch[1]!);
      const action = todoMatch[2];
      const row = this.todos.get(id);
      if (!row || row.owner !== email) return Response.json({ error: 'not_found', message: 'missing' }, { status: 404 });
      if (req.method === 'GET' && !action) return Response.json(publicTodo(row));
      if (req.method === 'POST' && action === 'check') {
        row.done = true;
        row.doneAt = new Date().toISOString();
        row.updatedAt = row.doneAt;
        return Response.json(publicTodo(row));
      }
      if (req.method === 'POST' && action === 'uncheck') {
        row.done = false;
        row.doneAt = null;
        row.updatedAt = new Date().toISOString();
        return Response.json(publicTodo(row));
      }
      if (req.method === 'DELETE' && !action) {
        this.todos.delete(id);
        return Response.json({ deleted: true });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      if (!email) return Response.json({ error: 'unauthenticated', message: 'sign in' }, { status: 401 });
      const counts = new Map<string, number>();
      for (const t of this.todos.values()) {
        if (t.owner !== email) continue;
        for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return Response.json({
        tags: [...counts.entries()].map(([name, count]) => ({ id: `tag_${name}`, name, count })),
      });
    }

    return Response.json({ error: 'not_found', message: 'route' }, { status: 404 });
  }
}

function publicTodo(row: TodoRow) {
  const { owner: _o, ...rest } = row;
  return rest;
}
