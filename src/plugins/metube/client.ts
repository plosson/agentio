import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { basename, extname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import type { MetubeAddRequest, MetubeCredentials, MetubeDownload, MetubeHistory, MetubeState } from './types';

const REQUEST_TIMEOUT_MS = 30_000;
/** `/add` answers only once yt-dlp has read the link, which takes a while for a long playlist. */
const ADD_TIMEOUT_MS = 10 * 60_000;
const PROFILE_ADD = 'agentio metube profile add --url <url>';

/** The server URL in its canonical form: http(s), no path parts that matter, no credentials, no trailing slash. */
export function parseServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new CliError('INVALID_PARAMS', `Not a URL: ${input.trim()}`, 'For example https://metube.example.com');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError('INVALID_PARAMS', 'The MeTube URL must be a plain http(s) address, without credentials', 'For example https://metube.example.com');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function stateOf(download: MetubeDownload, inDone: boolean): MetubeState {
  if (!inDone) return 'queued';
  return download.status === 'finished' ? 'finished' : 'failed';
}

/** A file name not yet taken in `dir`: `name`, else `name (1)`, `name (2)`… */
export function freePath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

export class MetubeClient implements ServiceClient {
  readonly url: string;
  private readonly authorization?: string;

  constructor(credentials: MetubeCredentials) {
    this.url = credentials.url;
    if (credentials.username !== undefined && credentials.password !== undefined) {
      this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    }
  }

  get host(): string {
    return new URL(this.url).host;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const v = await this.version();
      return { valid: true, info: `${this.host} (MeTube ${v.version}, yt-dlp ${v['yt-dlp']})` };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async version(): Promise<{ version: string; 'yt-dlp': string }> {
    return this.json('GET', 'version');
  }

  async history(): Promise<MetubeHistory> {
    const h = await this.json<Partial<MetubeHistory>>('GET', 'history');
    return { queue: h.queue ?? [], pending: h.pending ?? [], done: h.done ?? [] };
  }

  /** Queues a link. MeTube answers once it has read the link and queued every video in it. */
  async add(request: MetubeAddRequest): Promise<void> {
    const result = await this.json<{ status: string; msg?: string }>('POST', 'add', request, ADD_TIMEOUT_MS);
    if (result.status !== 'ok') {
      throw new CliError('API_ERROR', `MeTube could not add ${request.url}: ${result.msg ?? 'unknown error'}`);
    }
  }

  /** Removes downloads by key: from the queue (cancelling them) or from the finished list (and its file, when the server deletes files). */
  async delete(keys: string[], where: 'queue' | 'done'): Promise<void> {
    const result = await this.json<{ status: string; msg?: string }>('POST', 'delete', { ids: keys, where, delete_files: true });
    if (result.status !== 'ok') throw new CliError('API_ERROR', `MeTube could not delete: ${result.msg ?? 'unknown error'}`);
  }

  /** Downloads a finished file into `dir`, never overwriting, and returns its path. */
  async fetchFile(download: MetubeDownload, dir: string): Promise<string> {
    if (!download.filename) throw new CliError('NOT_FOUND', `MeTube has no file for "${download.title}"`);
    const base = download.download_type === 'audio' ? 'audio_download/' : 'download/';
    const path = base + download.filename.split('/').map(encodeURIComponent).join('/');
    const response = await this.request('GET', path, undefined, undefined);
    if (!response.ok) throw await this.errorFor(response, `download "${download.title}"`);
    if (!response.body) throw new CliError('API_ERROR', `MeTube sent an empty answer for "${download.title}"`);
    mkdirSync(dir, { recursive: true });
    const dest = freePath(dir, basename(download.filename));
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest, { flags: 'wx' }));
    return dest;
  }

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await this.request(method, path, body, timeoutMs);
    if (!response.ok) throw await this.errorFor(response, `${method} /${path}`);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError('API_ERROR', `MeTube at ${this.host} answered /${path} with something that is not JSON`, 'Check the profile URL points at MeTube');
    }
  }

  private async request(method: string, path: string, body: unknown, timeoutMs: number | undefined): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.authorization) headers.Authorization = this.authorization;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(`${this.url}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new CliError('NETWORK_ERROR', `MeTube at ${this.host} did not answer /${path} in time`);
      }
      throw new CliError('NETWORK_ERROR', `Cannot reach MeTube at ${this.host}`, 'Check the URL and your network');
    }
  }

  private async errorFor(response: Response, what: string): Promise<CliError> {
    const text = (await response.text().catch(() => '')).trim();
    if (response.status === 401 || response.status === 403) {
      return new CliError('AUTH_FAILED', `MeTube at ${this.host} refused the credentials`, `Add the profile again: ${PROFILE_ADD} --username <user>`);
    }
    if (response.status === 404) return new CliError('NOT_FOUND', `MeTube at ${this.host} has nothing at ${what}`);
    // aiohttp answers a refused request as "400: <reason>".
    const reason = text && text.length < 500 && !text.startsWith('<') ? `: ${text.replace(/^\d{3}:\s*/, '')}` : '';
    if (response.status === 400) return new CliError('INVALID_PARAMS', `MeTube refused to ${what}${reason}`);
    return new CliError('API_ERROR', `MeTube answered ${response.status} to ${what}${reason}`);
  }
}
