import { describe, expect, test } from 'bun:test';
import { boundaryFromContentType, splitCsvLine, type BatchDeps } from '../../../../src/plugins/google/gdrive/batch';
import {
  batchShortcut,
  createShortcutRequest,
  findExistingRequest,
  parseShortcutCsv,
  SHORTCUT_MIME,
} from '../../../../src/plugins/google/gdrive/shortcut';
import { resolveShortcutItems } from '../../../../src/plugins/google/gdrive/commands';
import { GDriveClient } from '../../../../src/plugins/google/gdrive/client';

const FOLDER = 'application/vnd.google-apps.folder';

interface Call {
  method: string;
  url: URL;
  body?: any;
}

interface FakeFile {
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  canAddChildren?: boolean;
  targetId?: string;
}

/** A tiny in-memory Drive behind a fake batch endpoint. */
function fakeDrive(files: Record<string, FakeFile>, opts: { failOnce?: Record<string, number>; fail?: Record<string, number> } = {}) {
  const batches: Call[][] = [];
  const failed = new Set<string>();
  let nextId = 1;
  const respond = (call: Call): [number, unknown] => {
    const id = decodeURIComponent(call.url.pathname.replace('/drive/v3/files', '').replace(/^\//, ''));
    const key = `${call.method} ${id || call.url.searchParams.get('q') || ''}`;
    if (opts.fail?.[key]) return [opts.fail[key], { error: { message: 'forced' } }];
    if (opts.failOnce?.[key] && !failed.has(key)) {
      failed.add(key);
      return [opts.failOnce[key], { error: { message: 'busy', errors: [{ reason: 'rateLimitExceeded' }] } }];
    }
    if (call.method === 'GET' && id) {
      const f = files[id];
      if (!f) return [404, { error: { message: `File not found: ${id}.` } }];
      return [200, { id, name: f.name, mimeType: f.mimeType, trashed: !!f.trashed, capabilities: { canAddChildren: f.canAddChildren ?? true } }];
    }
    if (call.method === 'GET') {
      const qs = call.url.searchParams.get('q')!;
      if (/ in parents/.test(qs)) return [400, { error: { message: 'Invalid Value' } }]; // what Drive answers
      const target = qs.match(/shortcutDetails\.targetId = '([^']+)'/)![1];
      const found = Object.entries(files).filter(([, f]) => f.mimeType === SHORTCUT_MIME && f.targetId === target && !f.trashed);
      return [200, { files: found.map(([fid, f]) => ({ id: fid, name: f.name, parents: f.parents })) }];
    }
    const b = call.body;
    if (!files[b.shortcutDetails.targetId]) return [404, { error: { message: `File not found: ${b.shortcutDetails.targetId}.` } }];
    const sid = `sc${nextId++}`;
    files[sid] = { name: b.name, mimeType: b.mimeType, parents: b.parents, targetId: b.shortcutDetails.targetId };
    return [200, { id: sid, name: b.name, parents: b.parents, shortcutDetails: { targetId: b.shortcutDetails.targetId } }];
  };

  const deps: BatchDeps = {
    getAccessToken: async () => 'tok',
    sleep: async () => {},
    random: () => 0.5,
    fetch: async (_url, init) => {
      const boundary = boundaryFromContentType((init.headers as Record<string, string>)['Content-Type'])!;
      const calls: { call: Call; cid: string }[] = String(init.body)
        .split(`--${boundary}`)
        .slice(1)
        .filter((p) => !p.startsWith('--'))
        .map((part) => {
          const cid = part.match(/Content-ID: <([^>]+)>/)![1];
          const line = part.match(/^(GET|POST|PATCH) (\S+) HTTP\/1\.1$/m)!;
          const json = part.match(/charset=UTF-8\r\n\r\n(.*)\r\n$/s);
          return { cid, call: { method: line[1], url: new URL(line[2], 'https://www.googleapis.com'), body: json ? JSON.parse(json[1]) : undefined } };
        });
      batches.push(calls.map((c) => c.call));
      const rb = 'resp_b';
      const text = calls
        .map(({ call, cid }) => {
          const [status, body] = respond(call);
          return `--${rb}\r\nContent-Type: application/http\r\nContent-ID: <response-${cid}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`;
        })
        .join('') + `--${rb}--\r\n`;
      return new Response(text, { headers: { 'content-type': `multipart/mixed; boundary=${rb}` } });
    },
  };
  return { deps, batches, files };
}

const base = (): Record<string, FakeFile> => ({
  T1: { name: 'Shared budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
  T2: { name: 'Specs', mimeType: 'application/pdf' },
  P: { name: 'Mine', mimeType: FOLDER },
  RO: { name: 'Read only', mimeType: FOLDER, canAddChildren: false },
  NF: { name: 'not a folder', mimeType: 'application/pdf' },
});

describe('CSV', () => {
  test('splitCsvLine honours quotes and escaped quotes', () => {
    expect(splitCsvLine('a, "b, c" ,"say ""hi"""')).toEqual(['a', 'b, c', 'say "hi"']);
    expect(splitCsvLine('a,,b')).toEqual(['a', '', 'b']);
  });

  test('parseShortcutCsv: optional name, header, comments', () => {
    expect(parseShortcutCsv('targetId,parentId,name\n# c\n\nT1,P\nT2,P,"Specs, v2"\nT3,P,\n')).toEqual([
      { targetId: 'T1', parent: 'P' },
      { targetId: 'T2', parent: 'P', name: 'Specs, v2' },
      { targetId: 'T3', parent: 'P' },
    ]);
  });

  test('parseShortcutCsv rejects bad lines', () => {
    expect(() => parseShortcutCsv('T1\nT1,P,n,extra\n,P')).toThrow(/line\(s\): 1, 2, 3/);
  });
});

describe('requests', () => {
  test('create sends the shortcut body with supportsAllDrives', () => {
    const r = createShortcutRequest('T1', 'P', 'N');
    expect(r.method).toBe('POST');
    expect(r.path).toStartWith('/drive/v3/files?supportsAllDrives=true');
    expect(r.body).toEqual({ name: 'N', mimeType: SHORTCUT_MIME, parents: ['P'], shortcutDetails: { targetId: 'T1' } });
  });

  test('existing-shortcut query escapes quotes', () => {
    const q = new URL(findExistingRequest("a'b").path, 'https://x').searchParams;
    expect(q.get('q')).toBe(`mimeType = '${SHORTCUT_MIME}' and shortcutDetails.targetId = 'a\\'b' and trashed = false`);
    expect(q.get('includeItemsFromAllDrives')).toBe('true');
    expect(q.get('supportsAllDrives')).toBe('true');
  });
});

describe('batchShortcut', () => {
  test('creates shortcuts named after the target, or the given name', async () => {
    const { deps, files } = fakeDrive(base());
    const { results, summary } = await batchShortcut([{ targetId: 'T1', parent: 'P' }, { targetId: 'T2', parent: 'P', name: 'Custom' }], deps);
    expect(summary).toEqual({ total: 2, ok: 2, error: 0, created: 2, existing: 0, dryRun: false });
    expect(results[0]).toMatchObject({ status: 'ok', name: 'Shared budget', shortcutId: 'sc1' });
    expect(results[1]).toMatchObject({ status: 'ok', name: 'Custom', shortcutId: 'sc2' });
    expect(files.sc1).toMatchObject({ mimeType: SHORTCUT_MIME, parents: ['P'], targetId: 'T1' });
  });

  test('an existing shortcut is reported, not duplicated, unless allowed', async () => {
    const f = {
      ...base(),
      ELSEWHERE: { name: 'Other folder link', mimeType: SHORTCUT_MIME, parents: ['Q'], targetId: 'T1' },
      OLD: { name: 'Budget link', mimeType: SHORTCUT_MIME, parents: ['P'], targetId: 'T1' },
    };
    const { deps, batches } = fakeDrive(f);
    const { results, summary } = await batchShortcut([{ targetId: 'T1', parent: 'P' }], deps);
    expect(results[0]).toMatchObject({ status: 'ok', existing: true, shortcutId: 'OLD', name: 'Budget link' });
    expect(summary).toMatchObject({ created: 0, existing: 1 });
    expect(batches.flat().some((c) => c.method === 'POST')).toBe(false);

    const again = await batchShortcut([{ targetId: 'T1', parent: 'P' }], deps, { allowDuplicates: true });
    expect(again.summary).toMatchObject({ created: 1, existing: 0 });
  });

  test('partial failures: unreadable target, bad parents, duplicates', async () => {
    const { deps } = fakeDrive(base());
    const { results, summary } = await batchShortcut(
      [
        { targetId: 'GONE', parent: 'P' },
        { targetId: 'T1', parent: 'NOPE' },
        { targetId: 'T1', parent: 'NF' },
        { targetId: 'T1', parent: 'RO' },
        { targetId: 'T2', parent: 'P' },
        { targetId: 'T2', parent: 'P' },
      ],
      deps
    );
    expect(results.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error', 'ok', 'error']);
    expect(results[0].error).toContain('Target not accessible: 404');
    expect(results[0].error).toContain('pass a name');
    expect(results[1].error).toContain('Parent folder not accessible: 404');
    expect(results[2].error).toContain('is not a folder');
    expect(results[3].error).toContain('No permission');
    expect(results[5].error).toContain('Duplicate');
    expect(summary).toMatchObject({ total: 6, ok: 1, error: 5, created: 1 });
  });

  test('an unreadable target with a name still tries the create', async () => {
    const f = base();
    const { deps, batches } = fakeDrive(f, { fail: { 'GET HIDDEN': 403 } });
    f.HIDDEN = { name: 'x', mimeType: 'application/pdf' };
    const { results } = await batchShortcut([{ targetId: 'HIDDEN', parent: 'P', name: 'Given' }], deps);
    expect(results[0]).toMatchObject({ status: 'ok', name: 'Given' });
    expect(results[0].note).toContain('could not be read');
    expect(batches.flat().filter((c) => c.method === 'POST').length).toBe(1);
  });

  test('dry run checks access and creates nothing', async () => {
    const { deps, batches } = fakeDrive(base());
    const { results, summary } = await batchShortcut([{ targetId: 'T1', parent: 'P' }, { targetId: 'GONE', parent: 'P', name: 'n' }], deps, { dryRun: true });
    expect(results[0]).toMatchObject({ status: 'ok', dryRun: true, name: 'Shared budget' });
    expect(results[1].status).toBe('error');
    expect(summary).toMatchObject({ dryRun: true, created: 0 });
    expect(batches.flat().every((c) => c.method === 'GET')).toBe(true);
  });

  test('chunks lookups to the batch size and retries rate-limited creates', async () => {
    const f = base();
    const items = Array.from({ length: 5 }, (_, i) => {
      f[`X${i}`] = { name: `x${i}`, mimeType: 'application/pdf' };
      return { targetId: `X${i}`, parent: 'P' };
    });
    const { deps, batches } = fakeDrive(f, { failOnce: { 'POST ': 429 } });
    const { summary } = await batchShortcut(items, deps, { chunkSize: 2 });
    expect(summary).toMatchObject({ total: 5, ok: 5, created: 5 });
    expect(batches.every((b) => b.length <= 2)).toBe(true);
  });
});

describe('resolveShortcutItems', () => {
  test('single form', async () => {
    expect(await resolveShortcutItems('T', { parent: 'P' })).toEqual([{ targetId: 'T', parent: 'P' }]);
    expect(await resolveShortcutItems('T', { parent: 'P', name: ' N ' })).toEqual([{ targetId: 'T', parent: 'P', name: 'N' }]);
  });

  test('batch form and errors', async () => {
    expect(await resolveShortcutItems(undefined, { batch: '-' }, async () => 'T,P,N')).toEqual([{ targetId: 'T', parent: 'P', name: 'N' }]);
    await expect(resolveShortcutItems('T', { batch: '-' }, async () => 'T,P')).rejects.toThrow(/cannot be combined/);
    await expect(resolveShortcutItems('T', {})).rejects.toThrow(/--parent is required/);
    await expect(resolveShortcutItems(undefined, {})).rejects.toThrow(/Specify/);
    await expect(resolveShortcutItems(undefined, { batch: '-' }, async () => '\n')).rejects.toThrow(/no shortcuts/);
  });
});

describe('Drive URLs', () => {
  test('are parsed into IDs', () => {
    const client = new GDriveClient({ accessToken: 't', refreshToken: 'r', expiryDate: Date.now() + 60_000, tokenType: 'Bearer', scope: 's', email: 'e', accessLevel: 'full' });
    const id = (u: string) => (client as any).extractFileId(u);
    expect(id('https://docs.google.com/document/d/1AbC_d-E/edit')).toBe('1AbC_d-E');
    expect(id('https://docs.google.com/spreadsheets/d/1SsS/edit#gid=0')).toBe('1SsS');
    expect(id('https://drive.google.com/file/d/1FfF/view')).toBe('1FfF');
    expect(id('https://drive.google.com/drive/folders/1DdD?usp=sharing')).toBe('1DdD');
    expect(id('https://drive.google.com/open?id=1OoO')).toBe('1OoO');
    expect(id('root')).toBe('root');
  });
});
