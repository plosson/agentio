import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError, type ErrorCode } from '../../utils/errors';
import { REQUEST_STATES, type HiggsfieldCredentials, type RequestStatus, type SubmitResponse, type UploadTicket } from './types';

export const HIGGSFIELD_API = 'https://api.higgsfield.ai';
const API_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const PROFILE_ADD = 'agentio higgsfield profile add';
/** A request id no account has: asking for its status proves the key without spending anything. */
const PROBE_REQUEST = '00000000-0000-0000-0000-000000000000';

/** A key as the console shows it, `<key id>:<key secret>`, else an error. */
export function parseKey(input: string): string {
  const key = input.trim();
  if (!/^[^\s:]+:\S+$/.test(key)) {
    throw new CliError('INVALID_PARAMS', 'A Higgsfield API key is "<key id>:<key secret>"', 'Create one at https://console.higgsfield.ai');
  }
  return key;
}

/** A model id as it appears in the endpoint path, such as higgsfield-ai/soul/v2/standard. */
export function parseModelId(input: string): string {
  const model = input.trim().replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(model)) {
    throw new CliError('INVALID_PARAMS', `Not a model id: ${input}`, 'For example higgsfield-ai/soul/v2/standard (see https://console.higgsfield.ai)');
  }
  return model;
}

function codeFor(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 || status === 409 || status === 422) return 'INVALID_PARAMS';
  return 'API_ERROR';
}

/** An answer the API refused, with what it said and when to try again. */
export class HiggsfieldApiError extends CliError {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds: number | null, suggestion?: string) {
    super(codeFor(status), message, suggestion);
  }

  /** 429, 5xx: the same call may work later (with the same Idempotency-Key for a submission). */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** `detail` is a string, a list of field errors (422) or an object with a message (429). */
function detailOf(body: unknown, raw: string): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((e) => {
      const { loc, msg } = (e ?? {}) as { loc?: unknown; msg?: unknown };
      const where = Array.isArray(loc) ? loc.filter((p) => p !== 'body').join('.') : '';
      return `${where ? `${where}: ` : ''}${typeof msg === 'string' ? msg : JSON.stringify(e)}`;
    }).join('; ');
  }
  if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') return (d as { message: string }).message;
  const text = raw.trim();
  return text && text.length < 300 && !text.startsWith('<') ? text : 'no details';
}

function retryAfterOf(response: Response, body: unknown): number | null {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0) return header;
  const fromBody = ((body as { detail?: { retry_after_seconds?: unknown } } | null)?.detail)?.retry_after_seconds;
  return typeof fromBody === 'number' ? fromBody : null;
}

function errorFor(status: number, what: string, detail: string, retryAfter: number | null): HiggsfieldApiError {
  switch (status) {
    case 401: return new HiggsfieldApiError(status, `Higgsfield refused the API key (${detail})`, null, `Add the profile again: ${PROFILE_ADD}`);
    case 403: return new HiggsfieldApiError(status, `Higgsfield refused to ${what}: ${detail}`, null, 'Not enough balance, or the key is disabled or expired: check https://console.higgsfield.ai');
    case 404: return new HiggsfieldApiError(status, `Higgsfield found nothing for ${what}: ${detail}`, null);
    case 409: return new HiggsfieldApiError(status, `Higgsfield cannot ${what} yet: ${detail}`, null, 'The request is still queued or in progress');
    case 429: return new HiggsfieldApiError(status, `Higgsfield is at its limit for this account: ${detail}`, retryAfter);
    case 423: case 503: return new HiggsfieldApiError(status, `Higgsfield cannot ${what} right now: ${detail}`, retryAfter, 'The model is blocked or not ready; try again later');
    default: return new HiggsfieldApiError(status, `Higgsfield answered ${status} to ${what}: ${detail}`, retryAfter);
  }
}

export class HiggsfieldClient implements ServiceClient {
  private readonly authorization: string;

  /** `baseUrl` is for tests; agentio always talks to api.higgsfield.ai. */
  constructor(credentials: HiggsfieldCredentials, private readonly baseUrl: string = HIGGSFIELD_API) {
    this.authorization = `Key ${credentials.key}`;
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.checkKey();
      return { valid: true, info: 'API key accepted' };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /** Asks for a request that does not exist: 404 means the key works, 401/403 that it does not. */
  async checkKey(): Promise<void> {
    try {
      await this.status(PROBE_REQUEST);
    } catch (error) {
      if (error instanceof HiggsfieldApiError && error.status === 404) return;
      throw error;
    }
  }

  async submit(model: string, body: Record<string, unknown>, idempotencyKey: string): Promise<SubmitResponse> {
    const answer = await this.json<SubmitResponse>('POST', `/${model}`, `submit to ${model}`, body, { 'Idempotency-Key': idempotencyKey });
    if (typeof answer.request_id !== 'string' || !answer.request_id) throw new CliError('API_ERROR', `Higgsfield accepted the request to ${model} but sent no request_id`);
    return answer;
  }

  async status(requestId: string): Promise<RequestStatus> {
    const answer = await this.json<RequestStatus>('GET', `/requests/${encodeURIComponent(requestId)}/status`, `request ${requestId}`);
    if (!REQUEST_STATES.includes(answer.status)) throw new CliError('API_ERROR', `Higgsfield sent an unknown status for ${requestId}: ${JSON.stringify(answer.status)}`);
    return answer;
  }

  /** Only while queued: a started request answers 400. */
  async cancel(requestId: string): Promise<void> {
    await this.call('POST', `/requests/${encodeURIComponent(requestId)}/cancel`, `cancel ${requestId}`);
  }

  /** Deletes a finished request's files, prompt and parameters. A running one answers 409. */
  async delete(requestId: string): Promise<void> {
    await this.json('DELETE', `/requests/${encodeURIComponent(requestId)}`, `delete ${requestId}`);
  }

  async estimate(model: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('POST', `/estimate/${model}`, `estimate ${model}`, body);
  }

  /** Puts the bytes in Higgsfield's storage and returns the public URL a model takes as input. */
  async upload(bytes: Blob, contentType: string): Promise<string> {
    const ticket = await this.json<UploadTicket>('POST', '/files/generate-upload-url', 'create an upload URL', { content_type: contentType });
    if (typeof ticket.upload_url !== 'string' || typeof ticket.public_url !== 'string') {
      throw new CliError('API_ERROR', 'Higgsfield sent no upload URL');
    }
    // The presigned URL gets only the headers Higgsfield listed, never the API key.
    const headers = ticket.upload_headers ?? { 'Content-Type': contentType };
    const response = await this.send(ticket.upload_url, { method: 'PUT', headers, body: bytes }, TRANSFER_TIMEOUT_MS, 'the upload');
    if (!response.ok) throw new CliError('API_ERROR', `Higgsfield's storage refused the upload (${response.status})`);
    return ticket.public_url;
  }

  /** Saves an output URL to `dest`, which must not exist yet. Output URLs need no key. */
  async download(url: string, dest: string): Promise<void> {
    const response = await this.send(url, { method: 'GET' }, TRANSFER_TIMEOUT_MS, 'the download');
    if (!response.ok || !response.body) throw new CliError('API_ERROR', `Download of ${url} failed (${response.status})`);
    if (existsSync(dest)) throw new CliError('INVALID_PARAMS', `${dest} already exists`);
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest, { flags: 'wx' }));
  }

  private async json<T>(method: string, path: string, what: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const raw = await this.call(method, path, what, body, headers);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as T;
    } catch { /* reported below */ }
    throw new CliError('API_ERROR', `Higgsfield answered ${what} with something that is not JSON`);
  }

  private async call(method: string, path: string, what: string, body?: unknown, headers: Record<string, string> = {}): Promise<string> {
    const init: RequestInit = { method, headers: { Authorization: this.authorization, ...headers } };
    if (body !== undefined) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await this.send(`${this.baseUrl}${path}`, init, API_TIMEOUT_MS, what);
    const raw = await response.text();
    if (response.ok) return raw;
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    throw errorFor(response.status, what, detailOf(parsed, raw), retryAfterOf(response, parsed));
  }

  private async send(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw new CliError('NETWORK_ERROR', `Higgsfield did not answer ${what} in time`);
      throw new CliError('NETWORK_ERROR', `Cannot reach Higgsfield for ${what}`, 'Check your network');
    }
  }
}
