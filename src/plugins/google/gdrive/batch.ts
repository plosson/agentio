import { CliError } from '../../../utils/errors';

/**
 * Batch moves over Drive's HTTP batch endpoint (`POST /batch/drive/v3`,
 * multipart/mixed). One batch carries up to 100 calls; each call still counts
 * against the quota as its own request, and Google may run them in any order.
 */

export const DRIVE_BATCH_URL = 'https://www.googleapis.com/batch/drive/v3';
export const MAX_BATCH_SIZE = 100;
export const DEFAULT_BATCH_SIZE = 50;

export interface MoveItem {
  fileId: string;
  dest: string;
}

export interface MoveResult {
  fileId: string;
  dest: string;
  status: 'ok' | 'error';
  name?: string;
  previousParents?: string[];
  parents?: string[];
  dryRun?: boolean;
  note?: string;
  error?: string;
}

export interface MoveSummary {
  total: number;
  ok: number;
  error: number;
  dryRun: boolean;
}

export interface BatchSubRequest {
  method: 'GET' | 'PATCH' | 'POST';
  /** Path and query only, e.g. `/drive/v3/files/abc?fields=parents`. Full URLs are not allowed. */
  path: string;
  body?: unknown;
}

export interface BatchSubResponse {
  status: number;
  body: any;
}

export interface BatchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  getAccessToken: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** Splits one CSV line on commas, honouring "quoted, fields" and "" escapes; fields are trimmed. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"' && !cur.trim()) {
      quoted = true;
      cur = '';
    } else if (c === ',') {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur.trim());
  return fields;
}

/**
 * The data rows of a small CSV: blank lines and `#` comments are skipped, and
 * so is a first line whose first field matches `header`. Each row must have
 * `min`..`max` fields with the first `min` non-empty, or the call throws with
 * the offending line numbers.
 */
export function parseCsvRows(text: string, spec: { min: number; max: number; header: RegExp; usage: string }): string[][] {
  const rows: string[][] = [];
  const bad: number[] = [];
  let sawData = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) return;
    const fields = splitCsvLine(line);
    if (!sawData && spec.header.test(fields[0])) {
      sawData = true;
      return;
    }
    sawData = true;
    if (fields.length < spec.min || fields.length > spec.max || fields.slice(0, spec.min).some((f) => !f)) {
      bad.push(i + 1);
      return;
    }
    rows.push(fields);
  });
  if (bad.length) {
    const shown = bad.slice(0, 10).join(', ') + (bad.length > 10 ? ', ...' : '');
    throw new CliError('INVALID_PARAMS', `Invalid batch line(s): ${shown}`, spec.usage);
  }
  return rows;
}

/**
 * `fileId,destFolderId` per line. A header line (`fileId,...`), blank lines and
 * `#` comments are skipped. Any other line without exactly two values is an error.
 */
export function parseMoveCsv(text: string): MoveItem[] {
  return parseCsvRows(text, { min: 2, max: 2, header: /^(file[_ -]?id|id)$/i, usage: 'Each line must be fileId,destFolderId' })
    .map(([fileId, dest]) => ({ fileId, dest }));
}

export function parseChunkSize(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
    throw new CliError('INVALID_PARAMS', `Invalid --chunk: ${value}`, `Use a whole number from 1 to ${MAX_BATCH_SIZE}`);
  }
  return n;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// multipart/mixed
// ---------------------------------------------------------------------------

export function buildBatchBody(requests: BatchSubRequest[], boundary: string): string {
  const parts = requests.map((req, i) => {
    const head = [
      `--${boundary}`,
      'Content-Type: application/http',
      `Content-ID: <item-${i}>`,
      'Content-Transfer-Encoding: binary',
      '',
    ];
    const inner = [`${req.method} ${req.path} HTTP/1.1`];
    if (req.body !== undefined) {
      inner.push('Content-Type: application/json; charset=UTF-8', '', JSON.stringify(req.body));
    } else {
      inner.push('');
    }
    return [...head, ...inner, ''].join('\r\n');
  });
  return parts.join('') + `--${boundary}--\r\n`;
}

export function boundaryFromContentType(contentType: string | null): string | null {
  const match = contentType?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match ? match[1] || match[2] : null;
}

function splitHead(text: string): [string, string] {
  const m = text.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return [text, ''];
  return [text.slice(0, m.index), text.slice(m.index + m[0].length)];
}

/**
 * Parses a multipart/mixed batch response into one entry per request, matched
 * by `Content-ID: <response-item-N>` (falling back to order). Missing parts
 * come back as status 0 so the caller can retry or fail them.
 */
export function parseBatchResponse(text: string, boundary: string, count: number): BatchSubResponse[] {
  const out: (BatchSubResponse | undefined)[] = new Array(count).fill(undefined);
  const segments = text.split(`--${boundary}`).slice(1);
  let order = 0;
  for (const seg of segments) {
    if (seg.startsWith('--')) break;
    const part = seg.replace(/^\r?\n/, '');
    if (!part.trim()) continue;
    const [partHead, httpMessage] = splitHead(part);
    const idMatch = partHead.match(/content-id:\s*<?response-item-(\d+)>?/i);
    const index = idMatch ? parseInt(idMatch[1], 10) : order;
    order++;
    const [httpHead, rawBody] = splitHead(httpMessage);
    const statusMatch = httpHead.match(/^HTTP\/[\d.]+\s+(\d{3})/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    const bodyText = rawBody.trim();
    let body: any = bodyText;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        // keep raw text
      }
    } else {
      body = undefined;
    }
    if (index >= 0 && index < count) out[index] = { status, body };
  }
  return out.map((r) => r ?? { status: 0, body: { error: { message: 'No response for this call in the batch' } } });
}

// ---------------------------------------------------------------------------
// Errors and retries
// ---------------------------------------------------------------------------

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

export function errorReasons(body: any): string[] {
  const errors = body?.error?.errors;
  return Array.isArray(errors) ? errors.map((e: any) => e?.reason).filter((r: unknown) => typeof r === 'string') : [];
}

/** 429, 5xx, a missing part, or a 403 whose reason is a rate limit. */
export function isRetryable(res: BatchSubResponse): boolean {
  if (res.status === 0 || res.status === 429 || res.status >= 500) return true;
  if (res.status === 403) return errorReasons(res.body).some((r) => RATE_LIMIT_REASONS.has(r));
  return false;
}

export function errorMessage(res: BatchSubResponse): string {
  const msg = res.body?.error?.message;
  const text = typeof msg === 'string' && msg ? msg : typeof res.body === 'string' && res.body ? res.body : 'Request failed';
  return res.status ? `${res.status}: ${text}` : text;
}

/** Exponential backoff with jitter: random in [cap/2, cap], cap = min(max, base * 2^attempt). */
export function backoffDelay(attempt: number, opts: RetryOptions = {}, random: () => number = Math.random): number {
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 32_000;
  const cap = Math.min(max, base * 2 ** attempt);
  return Math.round(cap / 2 + random() * (cap / 2));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends one batch and returns one response per request. */
export async function sendBatch(requests: BatchSubRequest[], deps: BatchDeps): Promise<BatchSubResponse[]> {
  if (requests.length === 0) return [];
  if (requests.length > MAX_BATCH_SIZE) {
    throw new CliError('INVALID_PARAMS', `A Drive batch holds at most ${MAX_BATCH_SIZE} calls`);
  }
  const boundary = `agentio_batch_${Date.now().toString(36)}_${Math.floor((deps.random ?? Math.random)() * 1e9).toString(36)}`;
  const token = await deps.getAccessToken();
  let res: Response;
  try {
    res = await deps.fetch(DRIVE_BATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
      },
      body: buildBatchBody(requests, boundary),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return requests.map(() => ({ status: 0, body: { error: { message: `Network error: ${message}` } } }));
  }
  const text = await res.text();
  if (!res.ok) {
    // The whole batch was refused (auth, outer rate limit, ...): every call gets that answer.
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // raw text
    }
    if (res.status === 401) {
      throw new CliError('AUTH_EXPIRED', 'Drive batch request was not authorized', 'Run: agentio profile reauth gdrive <profile>');
    }
    return requests.map(() => ({ status: res.status, body }));
  }
  const boundaryOut = boundaryFromContentType(res.headers.get('content-type'));
  if (!boundaryOut) {
    return requests.map(() => ({ status: 0, body: { error: { message: 'Batch response had no multipart boundary' } } }));
  }
  return parseBatchResponse(text, boundaryOut, requests.length);
}

/**
 * Sends requests in one batch, re-sending only the calls that hit a retryable
 * error, with exponential backoff and jitter, up to `maxRetries` times.
 */
export async function sendBatchWithRetry(
  requests: BatchSubRequest[],
  deps: BatchDeps,
  opts: RetryOptions = {}
): Promise<BatchSubResponse[]> {
  const maxRetries = opts.maxRetries ?? 5;
  const sleep = deps.sleep ?? defaultSleep;
  const results: BatchSubResponse[] = new Array(requests.length);
  let pending = requests.map((_, i) => i);
  for (let attempt = 0; pending.length > 0; attempt++) {
    const responses = await sendBatch(pending.map((i) => requests[i]), deps);
    const retry: number[] = [];
    responses.forEach((res, k) => {
      const index = pending[k];
      results[index] = res;
      if (isRetryable(res) && attempt < maxRetries) retry.push(index);
    });
    pending = retry;
    if (pending.length) await sleep(backoffDelay(attempt, opts, deps.random));
  }
  return results;
}

/** Like sendBatchWithRetry, for any number of requests: `size` calls per batch. */
export async function sendAllWithRetry(
  requests: BatchSubRequest[],
  deps: BatchDeps,
  size: number,
  opts: RetryOptions = {}
): Promise<BatchSubResponse[]> {
  const out: BatchSubResponse[] = [];
  for (const group of chunk(requests, size)) out.push(...(await sendBatchWithRetry(group, deps, opts)));
  return out;
}

export const isSuccess = (res: BatchSubResponse) => res.status >= 200 && res.status < 300;

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

function filePath(fileId: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ supportsAllDrives: 'true', ...params }).toString();
  return `/drive/v3/files/${encodeURIComponent(fileId)}?${query}`;
}

export function getParentsRequest(fileId: string): BatchSubRequest {
  return { method: 'GET', path: filePath(fileId, { fields: 'id,name,parents' }) };
}

export function moveRequest(fileId: string, dest: string, removeParents: string[]): BatchSubRequest {
  const params: Record<string, string> = { addParents: dest, fields: 'id,name,parents' };
  if (removeParents.length) params.removeParents = removeParents.join(',');
  return { method: 'PATCH', path: filePath(fileId, params), body: {} };
}

export interface BatchMoveOptions extends RetryOptions {
  chunkSize?: number;
  dryRun?: boolean;
  onResult?: (result: MoveResult) => void;
}

/**
 * Moves every item: one batch fetches current parents, a second batch moves
 * (addParents=dest, removeParents=old parents). Results keep the input order.
 */
export async function batchMove(items: MoveItem[], deps: BatchDeps, options: BatchMoveOptions = {}): Promise<{ results: MoveResult[]; summary: MoveSummary }> {
  const size = parseChunkSize(options.chunkSize);
  const results: MoveResult[] = [];
  const seen = new Set<string>();
  const emit = (r: MoveResult) => {
    results.push(r);
    options.onResult?.(r);
  };

  for (const group of chunk(items, size)) {
    const slotResults: (MoveResult | undefined)[] = new Array(group.length).fill(undefined);
    const toFetch: number[] = [];
    group.forEach((item, i) => {
      if (seen.has(item.fileId)) {
        slotResults[i] = { ...item, status: 'error', error: 'Duplicate fileId in input; only the first entry is moved' };
      } else {
        seen.add(item.fileId);
        toFetch.push(i);
      }
    });

    const fetched = await sendBatchWithRetry(toFetch.map((i) => getParentsRequest(group[i].fileId)), deps, options);
    const toMove: { index: number; remove: string[] }[] = [];
    toFetch.forEach((index, k) => {
      const item = group[index];
      const res = fetched[k];
      if (res.status < 200 || res.status >= 300) {
        slotResults[index] = { ...item, status: 'error', error: errorMessage(res) };
        return;
      }
      const previousParents: string[] = Array.isArray(res.body?.parents) ? res.body.parents : [];
      const name: string | undefined = res.body?.name;
      const remove = previousParents.filter((p) => p !== item.dest);
      if (previousParents.length > 0 && remove.length === 0) {
        slotResults[index] = { ...item, status: 'ok', name, previousParents, parents: previousParents, note: 'Already in destination', ...(options.dryRun ? { dryRun: true } : {}) };
        return;
      }
      if (options.dryRun) {
        slotResults[index] = { ...item, status: 'ok', name, previousParents, dryRun: true };
        return;
      }
      slotResults[index] = { ...item, status: 'ok', name, previousParents };
      toMove.push({ index, remove });
    });

    const moved = await sendBatchWithRetry(toMove.map(({ index, remove }) => moveRequest(group[index].fileId, group[index].dest, remove)), deps, options);
    toMove.forEach(({ index }, k) => {
      const res = moved[k];
      const prev = slotResults[index]!;
      if (res.status >= 200 && res.status < 300) {
        slotResults[index] = { ...prev, name: res.body?.name ?? prev.name, parents: res.body?.parents };
      } else {
        slotResults[index] = { ...prev, status: 'error', error: errorMessage(res) };
      }
    });

    for (const r of slotResults) emit(r!);
  }

  const ok = results.filter((r) => r.status === 'ok').length;
  return { results, summary: { total: results.length, ok, error: results.length - ok, dryRun: !!options.dryRun } };
}
