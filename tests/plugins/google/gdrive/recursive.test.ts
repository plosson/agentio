import { describe, expect, test } from 'bun:test';
import {
  childQuery,
  fileJson,
  FOLDER_MIME,
  PAGE_SIZE,
  parseMaxDepth,
  parseTextFields,
  SHORTCUT_MIME,
  textFieldValue,
  walkFolder,
  type ListPage,
} from '../../../../src/plugins/google/gdrive/recursive';
import { GDriveClient } from '../../../../src/plugins/google/gdrive/client';
import type { GDriveFile } from '../../../../src/plugins/google/gdrive/types';

interface Node {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  target?: { id: string; mime: string };
  trashed?: boolean;
}

const folder = (id: string, parent: string, name = id): Node => ({ id, name, mimeType: FOLDER_MIME, parent });
const file = (id: string, parent: string, mimeType = 'application/pdf'): Node => ({ id, name: `${id}.pdf`, mimeType, parent });
const shortcut = (id: string, parent: string, target: string): Node => ({ id, name: `link-${id}`, mimeType: SHORTCUT_MIME, parent, target: { id: target, mime: FOLDER_MIME } });

/** A fake files.list over a tree, understanding the queries childQuery builds, paged by `pageSize`. */
function fakeDrive(nodes: Node[], pageSize = 1000) {
  const calls: { q: string; pageToken?: string; fields: string }[] = [];
  const listPage: ListPage = async (q, pageToken, fields) => {
    calls.push({ q, pageToken, fields });
    const parent = q.match(/^'((?:[^'\\]|\\.)+)' in parents/)![1].replace(/\\'/g, "'");
    let hits = nodes.filter((n) => n.parent === parent);
    if (q.includes('trashed = false')) hits = hits.filter((n) => !n.trashed);
    if (q.includes(`mimeType = '${FOLDER_MIME}' or mimeType = '${SHORTCUT_MIME}'`)) hits = hits.filter((n) => n.mimeType === FOLDER_MIME || n.mimeType === SHORTCUT_MIME);
    const want = q.match(/\(mimeType = '([^']+)'\)$/);
    if (want) hits = hits.filter((n) => n.mimeType === want[1]);
    const start = pageToken ? Number(pageToken) : 0;
    const page = hits.slice(start, start + pageSize);
    return {
      files: page.map((n) => ({ id: n.id, name: n.name, mimeType: n.mimeType, ...(n.target ? { shortcutDetails: { targetId: n.target.id, targetMimeType: n.target.mime } } : {}) })),
      nextPageToken: start + pageSize < hits.length ? String(start + pageSize) : undefined,
    };
  };
  return { listPage, calls };
}

const TREE: Node[] = [
  folder('A', 'root', 'Alpha'),
  file('f1', 'root'),
  folder('B', 'A', 'Beta'),
  file('f2', 'A'),
  file('f3', 'B'),
  folder('C', 'B', 'Gamma'),
  file('f4', 'C'),
  shortcut('s1', 'C', 'A'), // points back up: a cycle when followed
  { ...file('gone', 'A'), trashed: true },
];

async function walk(nodes: Node[], opts: Parameters<typeof walkFolder>[2] = {}, start = 'root', pageSize?: number) {
  const { listPage, calls } = fakeDrive(nodes, pageSize);
  const out: [string, number][] = [];
  const res = await walkFolder(listPage, start, opts, (_f, path, depth) => out.push([path, depth]));
  return { out, calls, ...res };
}

describe('walkFolder', () => {
  test('lists everything breadth-first with paths and depths, skipping trash', async () => {
    const { out, truncated, folders } = await walk(TREE);
    expect(out).toEqual([
      ['Alpha', 1], ['f1.pdf', 1],
      ['Alpha/Beta', 2], ['Alpha/f2.pdf', 2],
      ['Alpha/Beta/f3.pdf', 3], ['Alpha/Beta/Gamma', 3],
      ['Alpha/Beta/Gamma/f4.pdf', 4], ['Alpha/Beta/Gamma/link-s1', 4],
    ]);
    expect(truncated).toBe(false);
    expect(folders).toBe(4);
  });

  test('shortcuts are listed but not followed by default; followed, the cycle is cut', async () => {
    const plain = await walk(TREE);
    expect(plain.calls.some((c) => c.q.startsWith("'A' in parents"))).toBe(true);
    expect(plain.calls.filter((c) => c.q.startsWith("'A' in parents")).length).toBe(1);

    const followed = await walk([...TREE, folder('X', 'outside', 'Elsewhere'), file('fx', 'X'), shortcut('s2', 'root', 'X')], { followShortcuts: true });
    expect(followed.out).toContainEqual(['link-s2/fx.pdf', 2]);
    // s1 -> A was already visited: walked once only, so the walk ends.
    expect(followed.calls.filter((c) => c.q.startsWith("'A' in parents")).length).toBe(1);
  });

  test('a shortcut to the start folder itself does not loop', async () => {
    const res = await walk([folder('S', 'root'), shortcut('back', 'S', 'S'), file('x', 'S')], { followShortcuts: true }, 'S');
    expect(res.out).toEqual([['link-back', 1], ['x.pdf', 1]]);
    expect(res.folders).toBe(1);
  });

  test('--max-depth stops descending', async () => {
    expect((await walk(TREE, { maxDepth: 1 })).out).toEqual([['Alpha', 1], ['f1.pdf', 1]]);
    const two = await walk(TREE, { maxDepth: 2 });
    expect(two.out.map(([, d]) => d)).toEqual([1, 1, 2, 2]);
    expect(two.folders).toBe(2);
  });

  test('pages through big folders', async () => {
    const many = Array.from({ length: 25 }, (_, i) => file(`p${i}`, 'root'));
    const res = await walk(many, {}, 'root', 10);
    expect(res.out.length).toBe(25);
    expect(res.calls.map((c) => c.pageToken)).toEqual([undefined, '10', '20']);
  });

  test('limit truncates and says so', async () => {
    const res = await walk(TREE, { limit: 3 });
    expect(res.out.length).toBe(3);
    expect(res.truncated).toBe(true);
    expect((await walk(TREE, { limit: 8 })).truncated).toBe(false);
  });

  test('with a query, folders are still walked through a folders-only query', async () => {
    const res = await walk(TREE, { query: "mimeType = 'application/pdf'" });
    expect(res.out).toEqual([['f1.pdf', 1], ['Alpha/f2.pdf', 2], ['Alpha/Beta/f3.pdf', 3], ['Alpha/Beta/Gamma/f4.pdf', 4]]);
    const folderOnly = res.calls.filter((c) => c.q.includes(`mimeType = '${FOLDER_MIME}' or`));
    expect(folderOnly.length).toBe(4);
    expect(folderOnly[0].fields).not.toContain('md5Checksum');
    expect(res.calls.find((c) => c.q.includes('application/pdf'))!.fields).toContain('md5Checksum');
  });

  test('--trash includes trashed items', async () => {
    expect((await walk(TREE, { includeTrash: true })).out).toContainEqual(['Alpha/gone.pdf', 2]);
  });
});

describe('helpers', () => {
  test('childQuery quotes ids and wraps the user query', () => {
    expect(childQuery("a'b", { query: "name contains 'x' or starred = true" }))
      .toBe("'a\\'b' in parents and trashed = false and (name contains 'x' or starred = true)");
    expect(childQuery('r', { includeTrash: true })).toBe("'r' in parents");
  });

  test('page size is the Drive maximum', () => {
    expect(PAGE_SIZE).toBe(1000);
  });

  test('parseMaxDepth', () => {
    expect(parseMaxDepth(undefined)).toBeUndefined();
    expect(parseMaxDepth('3')).toBe(3);
    expect(() => parseMaxDepth('0')).toThrow();
    expect(() => parseMaxDepth('x')).toThrow();
  });

  test('parseTextFields and values', () => {
    expect(parseTextFields('md5, bytes,md5')).toEqual(['md5', 'bytes']);
    expect(parseTextFields(undefined)).toEqual([]);
    expect(() => parseTextFields('md5,colour')).toThrow(/Unknown --fields: colour/);
    const doc: GDriveFile = { id: 'd', name: 'Doc', mimeType: 'application/vnd.google-apps.document', starred: false, trashed: false, shared: false };
    expect(textFieldValue(doc, 'md5')).toBe('-');
    expect(textFieldValue({ ...doc, md5Checksum: 'abc', size: 12 }, 'md5')).toBe('abc');
    expect(textFieldValue({ ...doc, size: 12 }, 'bytes')).toBe('12');
  });

  test('fileJson has null md5 and size where Drive has none', () => {
    const doc: GDriveFile = { id: 'd', name: 'Doc', mimeType: 'application/vnd.google-apps.document', starred: false, trashed: false, shared: false, modifiedTime: '2026-01-01T00:00:00Z' };
    expect(fileJson(doc)).toMatchObject({ md5Checksum: null, size: null, modifiedTime: '2026-01-01T00:00:00Z', parents: [] });
    expect(fileJson(doc)).not.toHaveProperty('path');
    expect(fileJson({ ...doc, path: 'a/Doc', depth: 2 })).toMatchObject({ path: 'a/Doc', depth: 2 });
  });
});

describe('client', () => {
  const CREDS = { accessToken: 't', refreshToken: 'r', expiryDate: Date.now() + 60_000, tokenType: 'Bearer', scope: 's', email: 'e', accessLevel: 'full' as const };

  test('list asks for md5Checksum with 1000-item pages and maps it', async () => {
    const client = new GDriveClient(CREDS);
    let params: any;
    (client as any).drive.files.list = async (p: any) => {
      params = p;
      return { data: { files: [{ id: 'a', name: 'a.pdf', mimeType: 'application/pdf', size: '1234', md5Checksum: 'ff', modifiedTime: 'T' }, { id: 'd', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }] } };
    };
    const files = await client.list({ limit: 5000 });
    expect(params.pageSize).toBe(1000);
    expect(params.fields).toContain('md5Checksum');
    expect(files[0]).toMatchObject({ size: 1234, md5Checksum: 'ff', modifiedTime: 'T' });
    expect(files[1].md5Checksum).toBeUndefined();
  });

  test('listRecursive walks with supportsAllDrives and folder,name order', async () => {
    const client = new GDriveClient(CREDS);
    const seen: any[] = [];
    (client as any).drive.files.list = async (p: any) => {
      seen.push(p);
      if (p.q.startsWith("'root' in parents")) return { data: { files: [{ id: 'F', name: 'Folder', mimeType: FOLDER_MIME }] } };
      return { data: { files: [{ id: 'x', name: 'x.bin', mimeType: 'application/octet-stream', md5Checksum: '00' }] } };
    };
    const { files } = await client.listRecursive({});
    expect(files.map((f) => [f.path, f.depth, f.md5Checksum])).toEqual([['Folder', 1, undefined], ['Folder/x.bin', 2, '00']]);
    expect(seen[0]).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true, orderBy: 'folder,name', pageSize: 1000 });
  });
});
