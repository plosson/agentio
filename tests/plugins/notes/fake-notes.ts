/**
 * An in-process apple-notes-api server for tests, on 127.0.0.1 with a random
 * port. It answers the routes and error bodies of apple-notes-api's
 * src/routes/*.ts: a Bearer key on /v1/*, `{ error, message }` failures, ids
 * matched as one path segment (an unencoded `x-coredata://` id has slashes and
 * matches no route, as on the real server), and the same validation limits.
 */

import { expect } from 'bun:test';
import { CliError } from '../../../src/utils/errors';

/** The CliError a promise rejects with; fails the test when it resolves or throws anything else. */
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
  rawPath: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
}

interface StoredNote {
  id: string;
  name: string;
  folder: string;
  bodyHtml: string;
  created: string;
  modified: string;
  locked?: boolean;
}

/** A failure the next /v1 request answers with instead of its normal answer. */
export interface Failure {
  status: number;
  body: unknown;
}

export const KEY = 'test-notes-key-0123456789';

export class FakeNotes {
  readonly log: LoggedRequest[] = [];
  folders = [
    { id: 'x-coredata://F/ICFolder/p1', name: 'Notes', account: 'iCloud' },
    { id: 'x-coredata://F/ICFolder/p2', name: 'Work', account: 'iCloud' },
  ];
  notes: StoredNote[] = [];
  platform = 'darwin';
  /** Answer every /v1 request with this, as a broken Notes.app would. */
  failNext: Failure | null = null;
  private seq = 100;
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => this.handle(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** A note already in Notes, as the user would have it. */
  seed(name: string, bodyHtml: string, folder = 'Notes', extra: Partial<StoredNote> = {}): StoredNote {
    const note: StoredNote = {
      id: `x-coredata://ABCD-1234/ICNote/p${this.seq++}`,
      name,
      folder,
      bodyHtml,
      created: '2026-09-01T10:00:00.000Z',
      modified: '2026-09-02T10:00:00.000Z',
      ...extra,
    };
    this.notes.push(note);
    return note;
  }

  private detail(n: StoredNote) {
    const body = n.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { id: n.id, name: n.name, folder: n.folder, created: n.created, modified: n.modified, body, bodyHtml: n.bodyHtml, bodyMarkdown: body };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // The raw path, as the real server routes on it: %2F stays encoded.
    const rawPath = req.url.slice(url.origin.length).split('?')[0];
    const text = await req.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    this.log.push({ method: req.method, rawPath, query: Object.fromEntries(url.searchParams), authorization: req.headers.get('authorization'), body });

    const json = (status: number, data: unknown) => Response.json(data, { status });

    if (req.method === 'GET' && rawPath === '/health') return json(200, { ok: true, version: '1.0.0', platform: this.platform });
    if (!rawPath.startsWith('/v1/')) return json(404, { error: 'NotFound', message: `No route ${req.method} ${rawPath}` });

    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
    if (auth?.[1]?.trim() !== KEY) return json(401, { error: 'Unauthorized', message: 'Valid Bearer API key required' });
    if (this.platform !== 'darwin') return json(501, { error: 'PlatformUnsupported', message: 'Apple Notes requires macOS' });
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return json(f.status, f.body);
    }

    if (req.method === 'GET' && rawPath === '/v1/folders') return json(200, { folders: this.folders });

    if (rawPath === '/v1/notes') {
      if (req.method === 'GET') {
        const q = url.searchParams;
        const limitRaw = q.get('limit');
        const limit = limitRaw === null ? 100 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          return json(400, { error: 'ValidationError', issues: { formErrors: [], fieldErrors: { limit: ['Number must be between 1 and 1000'] } } });
        }
        const folder = q.get('folder');
        const needle = q.get('q')?.toLowerCase();
        const items = this.notes
          .filter((n) => !folder || n.folder === folder)
          .filter((n) => !needle || n.name.toLowerCase().includes(needle) || n.bodyHtml.toLowerCase().includes(needle))
          .slice(0, limit)
          .map(({ id, name, folder: f, created, modified }) => ({ id, name, folder: f, created, modified }));
        return json(200, { notes: items });
      }
      if (req.method === 'POST') {
        const input = body as { name?: unknown; body?: unknown; folder?: unknown } | null;
        if (!input || typeof input.name !== 'string' || !input.name || typeof input.body !== 'string') {
          return json(400, { error: 'ValidationError', issues: { formErrors: [], fieldErrors: { name: ['Required'] } } });
        }
        const folder = typeof input.folder === 'string' ? input.folder : 'Notes';
        if (!this.folders.some((f) => f.name === folder)) return json(404, { error: 'NotFound', message: `Error: Folder not found: ${folder}` });
        const note = this.seed(input.name, input.body, folder, { created: '2026-10-01T12:00:00.000Z', modified: '2026-10-01T12:00:00.000Z' });
        return json(201, { note: this.detail(note) });
      }
    }

    const match = /^\/v1\/notes\/([^/]+)$/.exec(rawPath);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const note = this.notes.find((n) => n.id === id);
      if (!note) return json(404, { error: 'NotFound', message: 'Note not found' });
      if (note.locked) return json(403, { error: 'LockedNote', message: 'Password-protected notes cannot be read or modified via AppleScript.' });
      if (req.method === 'GET') return json(200, { note: this.detail(note) });
      if (req.method === 'PATCH') {
        const input = (body ?? {}) as { name?: string; body?: string; folder?: string };
        if (input.name === undefined && input.body === undefined && input.folder === undefined) {
          return json(400, { error: 'ValidationError', issues: { formErrors: ['At least one of name, body, folder is required'], fieldErrors: {} } });
        }
        if (input.folder !== undefined && !this.folders.some((f) => f.name === input.folder)) {
          return json(404, { error: 'NotFound', message: `Error: Folder not found: ${input.folder}` });
        }
        if (input.name !== undefined) note.name = input.name;
        if (input.body !== undefined) note.bodyHtml = input.body;
        if (input.folder !== undefined) note.folder = input.folder;
        note.modified = '2026-10-01T13:00:00.000Z';
        return json(200, { note: this.detail(note) });
      }
      if (req.method === 'DELETE') {
        this.notes = this.notes.filter((n) => n !== note);
        return json(200, { ok: true, id, movedToRecentlyDeleted: true });
      }
    }
    return json(404, { error: 'NotFound', message: `No route ${req.method} ${rawPath}` });
  }
}
