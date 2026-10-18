import { describe, expect, test } from 'bun:test';
import {
  backoffDelay,
  batchMove,
  boundaryFromContentType,
  buildBatchBody,
  chunk,
  isRetryable,
  moveRequest,
  getParentsRequest,
  parseBatchResponse,
  parseChunkSize,
  parseMoveCsv,
  sendBatchWithRetry,
  type BatchDeps,
  type BatchSubRequest,
} from '../../../../src/plugins/google/gdrive/batch';
import { resolveMoveItems } from '../../../../src/plugins/google/gdrive/commands';

// ---------------------------------------------------------------------------
// A fake Drive batch endpoint
// ---------------------------------------------------------------------------

interface ParsedCall {
  method: string;
  path: string;
  fileId: string;
  query: URLSearchParams;
  contentId: string;
}

function parseRequestBody(body: string, contentType: string): ParsedCall[] {
  const boundary = boundaryFromContentType(contentType)!;
  return body
    .split(`--${boundary}`)
    .slice(1)
    .filter((p) => !p.startsWith('--'))
    .map((part) => {
      const contentId = part.match(/Content-ID: <([^>]+)>/)![1];
      const line = part.match(/^(GET|PATCH) (\S+) HTTP\/1\.1$/m)!;
      const url = new URL(line[2], 'https://www.googleapis.com');
      return {
        method: line[1],
        path: line[2],
        fileId: decodeURIComponent(url.pathname.split('/').pop()!),
        query: url.searchParams,
        contentId,
      };
    });
}

type Answer = { status: number; body?: unknown };

function batchResponse(calls: ParsedCall[], answer: (call: ParsedCall) => Answer, reverse = false): Response {
  const b = 'batch_resp_xyz';
  const ordered = reverse ? [...calls].reverse() : calls;
  const parts = ordered.map((call) => {
    const { status, body } = answer(call);
    const json = body === undefined ? '' : JSON.stringify(body);
    return `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-${call.contentId}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json}\r\n`;
  });
  return new Response(parts.join('') + `--${b}--\r\n`, {
    status: 200,
    headers: { 'content-type': `multipart/mixed; boundary=${b}` },
  });
}

function fakeDrive(parents: Record<string, string[]>, opts: { failOnce?: Record<string, Answer>; fail?: Record<string, Answer>; reverse?: boolean } = {}) {
  const sent: ParsedCall[][] = [];
  const failedOnce = new Set<string>();
  const sleeps: number[] = [];
  const deps: BatchDeps = {
    getAccessToken: async () => 'tok',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    fetch: async (_url, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      const calls = parseRequestBody(String(init.body), (init.headers as Record<string, string>)['Content-Type']);
      sent.push(calls);
      return batchResponse(
        calls,
        (call) => {
          const key = `${call.method} ${call.fileId}`;
          if (opts.fail?.[key]) return opts.fail[key];
          if (opts.failOnce?.[key] && !failedOnce.has(key)) {
            failedOnce.add(key);
            return opts.failOnce[key];
          }
          if (!(call.fileId in parents)) return { status: 404, body: { error: { code: 404, message: `File not found: ${call.fileId}.` } } };
          if (call.method === 'GET') return { status: 200, body: { id: call.fileId, name: `name-${call.fileId}`, parents: parents[call.fileId] } };
          const remove = (call.query.get('removeParents') || '').split(',').filter(Boolean);
          const add = call.query.get('addParents')!;
          parents[call.fileId] = [...parents[call.fileId].filter((p) => !remove.includes(p)), add];
          return { status: 200, body: { id: call.fileId, name: `name-${call.fileId}`, parents: parents[call.fileId] } };
        },
        opts.reverse
      );
    },
  };
  return { deps, sent, sleeps };
}

const RATE_LIMIT_403: Answer = { status: 403, body: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } };

// ---------------------------------------------------------------------------

describe('parseMoveCsv', () => {
  test('reads fileId,dest lines and skips header, blanks and comments', () => {
    const text = '\uFEFFfileId,destFolderId\r\n\n# a comment\nA,F1\n  B , F2 \n"C","F3"\n';
    expect(parseMoveCsv(text)).toEqual([
      { fileId: 'A', dest: 'F1' },
      { fileId: 'B', dest: 'F2' },
      { fileId: 'C', dest: 'F3' },
    ]);
  });

  test('header is optional', () => {
    expect(parseMoveCsv('A,F1')).toEqual([{ fileId: 'A', dest: 'F1' }]);
  });

  test('a header-looking line after data is an error, not skipped', () => {
    expect(() => parseMoveCsv('A,F1\nfileId')).toThrow(/line\(s\): 2/);
  });

  test('reports bad line numbers', () => {
    expect(() => parseMoveCsv('A,F1\nB\nC,F,X\n,F')).toThrow(/Invalid batch line\(s\): 2, 3, 4/);
  });
});

describe('parseChunkSize / chunk', () => {
  test('defaults to 50 and enforces 1..100', () => {
    expect(parseChunkSize(undefined)).toBe(50);
    expect(parseChunkSize('100')).toBe(100);
    expect(() => parseChunkSize('101')).toThrow();
    expect(() => parseChunkSize('0')).toThrow();
    expect(() => parseChunkSize('abc')).toThrow();
  });

  test('chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('multipart batch body', () => {
  test('builds application/http parts with relative paths and JSON bodies', () => {
    const reqs: BatchSubRequest[] = [getParentsRequest('a/b'), moveRequest('f1', 'dest', ['p1', 'p2'])];
    const body = buildBatchBody(reqs, 'XX');
    expect(body.startsWith('--XX\r\nContent-Type: application/http\r\nContent-ID: <item-0>\r\n')).toBe(true);
    expect(body).toContain('GET /drive/v3/files/a%2Fb?supportsAllDrives=true&fields=id%2Cname%2Cparents HTTP/1.1');
    expect(body).toContain('PATCH /drive/v3/files/f1?supportsAllDrives=true&addParents=dest&fields=id%2Cname%2Cparents&removeParents=p1%2Cp2 HTTP/1.1');
    expect(body).toContain('Content-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n');
    expect(body.endsWith('--XX--\r\n')).toBe(true);
    expect(body).not.toContain('https://');
  });

  test('moveRequest omits removeParents when there are none', () => {
    expect(moveRequest('f', 'd', []).path).not.toContain('removeParents');
  });
});

describe('parseBatchResponse', () => {
  test('matches parts by Content-ID even when out of order', () => {
    const text = [
      '--b1\r\nContent-Type: application/http\r\nContent-ID: <response-item-1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{"message":"nope"}}\r\n',
      '--b1\r\nContent-Type: application/http\r\nContent-ID: <response-item-0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"a"}\r\n',
      '--b1--\r\n',
    ].join('');
    const out = parseBatchResponse(text, 'b1', 3);
    expect(out[0]).toEqual({ status: 200, body: { id: 'a' } });
    expect(out[1].status).toBe(404);
    expect(out[1].body.error.message).toBe('nope');
    expect(out[2].status).toBe(0); // missing -> retryable placeholder
  });

  test('falls back to order and handles LF-only and empty bodies', () => {
    const text = '--b\nContent-Type: application/http\n\nHTTP/1.1 204 No Content\n\n\n--b\nContent-Type: application/http\n\nHTTP/1.1 200 OK\n\n{"x":1}\n--b--';
    const out = parseBatchResponse(text, 'b', 2);
    expect(out[0]).toEqual({ status: 204, body: undefined });
    expect(out[1]).toEqual({ status: 200, body: { x: 1 } });
  });

  test('reads quoted and unquoted boundaries', () => {
    expect(boundaryFromContentType('multipart/mixed; boundary=batch_abc')).toBe('batch_abc');
    expect(boundaryFromContentType('multipart/mixed; boundary="q r"')).toBe('q r');
    expect(boundaryFromContentType('application/json')).toBeNull();
  });
});

describe('retry logic', () => {
  test('isRetryable', () => {
    expect(isRetryable({ status: 429, body: {} })).toBe(true);
    expect(isRetryable({ status: 500, body: {} })).toBe(true);
    expect(isRetryable({ status: 503, body: {} })).toBe(true);
    expect(isRetryable({ status: 0, body: {} })).toBe(true);
    expect(isRetryable(RATE_LIMIT_403 as any)).toBe(true);
    expect(isRetryable({ status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } })).toBe(true);
    expect(isRetryable({ status: 403, body: { error: { errors: [{ reason: 'insufficientFilePermissions' }] } } })).toBe(false);
    expect(isRetryable({ status: 404, body: {} })).toBe(false);
    expect(isRetryable({ status: 400, body: {} })).toBe(false);
  });

  test('backoff grows exponentially, is capped and jittered', () => {
    expect(backoffDelay(0, {}, () => 0)).toBe(500);
    expect(backoffDelay(0, {}, () => 1)).toBe(1000);
    expect(backoffDelay(3, {}, () => 1)).toBe(8000);
    expect(backoffDelay(10, {}, () => 1)).toBe(32000);
    expect(backoffDelay(2, { baseDelayMs: 10, maxDelayMs: 100 }, () => 0.5)).toBe(30);
  });

  test('re-sends only the calls that hit a retryable error', async () => {
    const { deps, sent, sleeps } = fakeDrive({ a: ['p'], b: ['p'], c: ['p'] }, { failOnce: { 'GET b': RATE_LIMIT_403 } });
    const out = await sendBatchWithRetry(['a', 'b', 'c'].map(getParentsRequest), deps);
    expect(out.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(sent.map((calls) => calls.map((c) => c.fileId))).toEqual([['a', 'b', 'c'], ['b']]);
    expect(sleeps.length).toBe(1);
  });

  test('gives up after maxRetries and keeps the last error', async () => {
    const { deps, sent } = fakeDrive({ a: ['p'] }, { fail: { 'GET a': { status: 503, body: { error: { message: 'busy' } } } } });
    const out = await sendBatchWithRetry([getParentsRequest('a')], deps, { maxRetries: 2 });
    expect(out[0].status).toBe(503);
    expect(sent.length).toBe(3);
  });

  test('a refused outer request is retried for every call', async () => {
    let n = 0;
    const deps: BatchDeps = {
      getAccessToken: async () => 't',
      sleep: async () => {},
      fetch: async () => {
        n++;
        if (n === 1) return new Response('{"error":{"message":"slow down"}}', { status: 429 });
        return batchResponse([{ method: 'GET', path: '', fileId: 'a', query: new URLSearchParams(), contentId: 'item-0' }], () => ({ status: 200, body: { id: 'a' } }));
      },
    };
    const out = await sendBatchWithRetry([getParentsRequest('a')], deps);
    expect(out[0].status).toBe(200);
    expect(n).toBe(2);
  });

  test('401 on the batch is an auth error', async () => {
    const deps: BatchDeps = { getAccessToken: async () => 't', fetch: async () => new Response('', { status: 401 }) };
    await expect(sendBatchWithRetry([getParentsRequest('a')], deps)).rejects.toThrow(/not authorized/);
  });
});

describe('batchMove', () => {
  test('moves every file, removing all previous parents, in input order', async () => {
    const parents: Record<string, string[]> = { a: ['old1'], b: ['old1', 'old2'], c: [] };
    const { deps, sent } = fakeDrive(parents, { reverse: true });
    const { results, summary } = await batchMove(
      [{ fileId: 'a', dest: 'D' }, { fileId: 'b', dest: 'D' }, { fileId: 'c', dest: 'E' }],
      deps
    );
    expect(summary).toEqual({ total: 3, ok: 3, error: 0, dryRun: false });
    expect(results.map((r) => r.fileId)).toEqual(['a', 'b', 'c']);
    expect(parents).toEqual({ a: ['D'], b: ['D'], c: ['E'] });
    expect(results[1]).toMatchObject({ status: 'ok', previousParents: ['old1', 'old2'], parents: ['D'], name: 'name-b' });
    const patch = sent[1].find((c) => c.fileId === 'b')!;
    expect(patch.query.get('removeParents')).toBe('old1,old2');
    expect(patch.query.get('supportsAllDrives')).toBe('true');
  });

  test('partial failures: missing file, permission error after GET, duplicate', async () => {
    const parents: Record<string, string[]> = { a: ['p'], b: ['p'] };
    const { deps } = fakeDrive(parents, {
      fail: { 'PATCH b': { status: 403, body: { error: { message: 'The user does not have sufficient permissions', errors: [{ reason: 'insufficientFilePermissions' }] } } } },
    });
    const { results, summary } = await batchMove(
      [{ fileId: 'a', dest: 'D' }, { fileId: 'missing', dest: 'D' }, { fileId: 'b', dest: 'D' }, { fileId: 'a', dest: 'E' }],
      deps
    );
    expect(summary).toMatchObject({ total: 4, ok: 1, error: 3 });
    expect(results[0].status).toBe('ok');
    expect(results[1]).toMatchObject({ status: 'error', error: '404: File not found: missing.' });
    expect(results[2]).toMatchObject({ status: 'error', error: '403: The user does not have sufficient permissions' });
    expect(results[3]).toMatchObject({ status: 'error' });
    expect(results[3].error).toContain('Duplicate');
    expect(parents.a).toEqual(['D']);
    expect(parents.b).toEqual(['p']);
  });

  test('dry run only fetches parents', async () => {
    const parents: Record<string, string[]> = { a: ['p'] };
    const { deps, sent } = fakeDrive(parents);
    const { results, summary } = await batchMove([{ fileId: 'a', dest: 'D' }], deps, { dryRun: true });
    expect(sent.length).toBe(1);
    expect(sent[0][0].method).toBe('GET');
    expect(results[0]).toMatchObject({ status: 'ok', dryRun: true, previousParents: ['p'] });
    expect(summary.dryRun).toBe(true);
    expect(parents.a).toEqual(['p']);
  });

  test('a file already in the destination is not patched', async () => {
    const { deps, sent } = fakeDrive({ a: ['D'] });
    const { results } = await batchMove([{ fileId: 'a', dest: 'D' }], deps);
    expect(results[0]).toMatchObject({ status: 'ok', note: 'Already in destination' });
    expect(sent.length).toBe(1);
  });

  test('splits into chunks and retries rate-limited moves', async () => {
    const parents: Record<string, string[]> = {};
    const items = Array.from({ length: 7 }, (_, i) => {
      parents[`f${i}`] = ['p'];
      return { fileId: `f${i}`, dest: 'D' };
    });
    const { deps, sent } = fakeDrive(parents, { failOnce: { 'PATCH f4': { status: 429, body: {} } } });
    const seen: string[] = [];
    const { summary } = await batchMove(items, deps, { chunkSize: 3, onResult: (r) => seen.push(r.fileId) });
    expect(summary).toMatchObject({ total: 7, ok: 7, error: 0 });
    expect(seen).toEqual(items.map((i) => i.fileId));
    expect(sent.every((calls) => calls.length <= 3)).toBe(true);
    // 3 chunks x (GET + PATCH) + 1 retry of f4
    expect(sent.length).toBe(7);
    expect(sent.some((calls) => calls.length === 1 && calls[0].fileId === 'f4' && calls[0].method === 'PATCH')).toBe(true);
  });
});

describe('resolveMoveItems', () => {
  test('ids with --to', async () => {
    expect(await resolveMoveItems(['a', 'b'], { to: 'D' })).toEqual([{ fileId: 'a', dest: 'D' }, { fileId: 'b', dest: 'D' }]);
  });

  test('two ids without --to keep the old meaning', async () => {
    expect(await resolveMoveItems(['a', 'D'], {})).toEqual([{ fileId: 'a', dest: 'D' }]);
  });

  test('--batch reads the CSV', async () => {
    const read = async (src: string) => (src === '-' ? 'fileId,dest\nA,F\n' : null);
    expect(await resolveMoveItems([], { batch: '-' }, read)).toEqual([{ fileId: 'A', dest: 'F' }]);
  });

  test('rejects mixed or incomplete forms', async () => {
    await expect(resolveMoveItems(['a'], { batch: '-' }, async () => 'A,F')).rejects.toThrow(/cannot be combined/);
    await expect(resolveMoveItems([], { batch: '-' }, async () => null)).rejects.toThrow(/stdin/);
    await expect(resolveMoveItems([], { batch: '-' }, async () => '# nothing\n')).rejects.toThrow(/no moves/);
    await expect(resolveMoveItems(['a'], {})).rejects.toThrow(/Specify/);
    await expect(resolveMoveItems([], { to: 'D' })).rejects.toThrow(/at least one/);
  });
});
