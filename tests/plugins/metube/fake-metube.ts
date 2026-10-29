/**
 * A small MeTube on a local Bun.serve: /version, /history, /add, /delete and /download/, behind optional basic auth.
 * An added link becomes a queued download that finishes (or fails) on the next /history call.
 */
import type { MetubeDownload } from '../../../src/plugins/metube/types';

export interface FakeOptions {
  auth?: { username: string; password: string };
  /** Links that fail, with their error. */
  failing?: Record<string, string>;
  /** Links that expand to several videos, as a playlist does. */
  playlists?: Record<string, string[]>;
}

export class FakeMetube {
  readonly url: string;
  readonly requests: { method: string; path: string; body?: any; authorization: string | null }[] = [];
  readonly queue = new Map<string, MetubeDownload>();
  readonly done = new Map<string, MetubeDownload>();
  readonly files = new Map<string, string>();
  private readonly server: ReturnType<typeof Bun.serve>;
  private clock = 1;

  constructor(private readonly options: FakeOptions = {}) {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
    this.url = `http://localhost:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(req: Request): Promise<Response> {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const body = req.method === 'POST' ? await req.json() : undefined;
    const authorization = req.headers.get('authorization');
    this.requests.push({ method: req.method, path, body, authorization });
    const { auth } = this.options;
    if (auth && authorization !== `Basic ${btoa(`${auth.username}:${auth.password}`)}`) return new Response('Unauthorized', { status: 401 });
    if (path === '/version') return Response.json({ 'yt-dlp': '2026.10.26', version: '2026.10.27' });
    if (path === '/history') {
      const history = { queue: [...this.queue.values()], pending: [], done: [...this.done.values()] };
      for (const [key, d] of this.queue) this.finish(key, d);
      return Response.json(history);
    }
    if (path === '/add') {
      if (!['video', 'audio'].includes(body.download_type)) return new Response('400: bad download_type', { status: 400 });
      if (body.quality === 'nope') return new Response("400: quality 'nope' is not one of best, 1080", { status: 400 });
      for (const url of this.options.playlists?.[body.url] ?? [body.url]) {
        this.done.delete(url);
        const id = url.split(/[=/]/).pop()!;
        this.queue.set(url, {
          id, url, title: `Video ${id}`, status: 'downloading', download_type: body.download_type,
          format: body.format, quality: body.quality, folder: body.folder ?? null, percent: 50, timestamp: this.clock++,
        });
      }
      return Response.json({ status: 'ok' });
    }
    if (path === '/delete') {
      for (const key of body.ids) {
        if (body.where === 'done') {
          const d = this.done.get(key);
          if (d?.filename) this.files.delete(`${d.download_type === 'audio' ? '/audio_download/' : '/download/'}${d.filename}`);
          this.done.delete(key);
        } else this.queue.delete(key);
      }
      return Response.json({ status: 'ok' });
    }
    const file = this.files.get(path);
    if (file !== undefined) return new Response(file);
    return new Response('404: Not Found', { status: 404 });
  }

  private finish(key: string, d: MetubeDownload): void {
    this.queue.delete(key);
    const error = this.options.failing?.[key];
    if (error) {
      this.done.set(key, { ...d, status: 'error', msg: error, error });
      return;
    }
    const ext = d.download_type === 'audio' ? (d.format ?? 'mp3') : 'mp4';
    const filename = `${d.folder ? `${d.folder}/` : ''}${d.title}.${ext}`;
    this.done.set(key, { ...d, status: 'finished', percent: 100, filename, size: 5 });
    this.files.set(`${d.download_type === 'audio' ? '/audio_download/' : '/download/'}${filename}`, `bytes of ${d.title}`);
  }
}
