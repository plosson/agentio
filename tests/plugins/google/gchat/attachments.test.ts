import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  attachmentKind,
  buildAttachmentFilename,
  dedupeFilename,
  driveExportUrl,
  exportAttachments,
  grantAllowsDrive,
  manifestToCsv,
  mapChatMessage,
  mediaDownloadUrl,
  messageMarkers,
  normalizeMessageId,
  normalizeSpaceId,
  openAttachment,
  planDriveDownload,
  sanitizeFilenamePart,
  threadResourceName,
  type DownloadDeps,
} from '../../../../src/plugins/google/gchat/attachments';
import { printGChatMessage, printGChatMessageList } from '../../../../src/plugins/google/gchat/output';
import { parseDateOption } from '../../../../src/plugins/google/gchat/commands';
import { GChatClient } from '../../../../src/plugins/google/gchat/client';
import { SCOPES } from '../../../../src/plugins/google/oauth';
import type { GChatAttachment, GChatMessage } from '../../../../src/plugins/google/gchat/types';

const UPLOAD: GChatAttachment = {
  name: 'spaces/S/messages/M.M/attachments/A1',
  contentName: 'photo.jpg',
  contentType: 'image/jpeg',
  source: 'UPLOADED_CONTENT',
  attachmentDataRef: { resourceName: 'spaces/S/messages/M.M/attachments/A1' },
};
const DRIVE: GChatAttachment = {
  name: 'spaces/S/messages/M2/attachments/A2',
  contentName: 'Plan',
  contentType: 'application/vnd.google-apps.document',
  source: 'DRIVE_FILE',
  driveDataRef: { driveFileId: 'drive-file-1' },
};

/** A fetch that answers by URL prefix and records every call. */
function fakeFetch(routes: Array<[string, () => Response]>) {
  const calls: { url: string; auth?: string }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    return route ? route[1]() : new Response('{"error":{"message":"nope"}}', { status: 404 });
  };
  const deps: DownloadDeps = { fetch, getAccessToken: async () => 'tok' };
  return { calls, deps };
}

function captureLog(run: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { run(); } finally { console.log = original; }
  return lines.join('\n');
}

describe('resource names', () => {
  test('space ids are accepted bare or as spaces/ resource names', () => {
    expect(normalizeSpaceId('AAAAU78G66k')).toBe('AAAAU78G66k');
    expect(normalizeSpaceId('spaces/AAAAU78G66k')).toBe('AAAAU78G66k');
    expect(normalizeSpaceId(' spaces/AAAAU78G66k/ ')).toBe('AAAAU78G66k');
    expect(normalizeSpaceId('EA - Team')).toBe('EA - Team');
  });

  test('message ids are accepted bare or as full names', () => {
    expect(normalizeMessageId('IJI.IJI')).toBe('IJI.IJI');
    expect(normalizeMessageId('spaces/S/messages/IJI.IJI')).toBe('IJI.IJI');
  });

  test('thread ids are accepted bare or as full names', () => {
    expect(threadResourceName('S', 'T1')).toBe('spaces/S/threads/T1');
    expect(threadResourceName('S', 'spaces/S/threads/T1')).toBe('spaces/S/threads/T1');
  });
});

describe('mapChatMessage', () => {
  test('keeps attachments with every field, plus cardsV2, annotations and gifs', () => {
    const msg = mapChatMessage({
      name: 'spaces/S/messages/M.M',
      createTime: '2026-10-01T10:00:00Z',
      lastUpdateTime: '2026-10-01T11:00:00Z',
      thread: { name: 'spaces/S/threads/T' },
      attachment: [{
        ...UPLOAD,
        thumbnailUri: 'https://thumb',
        downloadUri: 'https://dl',
        attachmentDataRef: { resourceName: 'RES', attachmentUploadToken: 'secret-upload-token' },
      }, { ...DRIVE }],
      cardsV2: [{ cardId: 'c1' }],
      annotations: [{ type: 'USER_MENTION' }],
      attachedGifs: [{ uri: 'https://gif' }],
    }, { name: 'users/1', displayName: 'Ann' });

    expect(msg.updateTime).toBe('2026-10-01T11:00:00Z');
    expect(msg.text).toBeUndefined();
    expect(msg.attachment).toEqual([
      {
        name: UPLOAD.name, contentName: 'photo.jpg', contentType: 'image/jpeg', source: 'UPLOADED_CONTENT',
        attachmentDataRef: { resourceName: 'RES' }, thumbnailUri: 'https://thumb', downloadUri: 'https://dl',
      },
      {
        name: DRIVE.name, contentName: 'Plan', contentType: 'application/vnd.google-apps.document',
        source: 'DRIVE_FILE', driveDataRef: { driveFileId: 'drive-file-1' },
      },
    ]);
    expect(JSON.stringify(msg)).not.toContain('secret-upload-token');
    expect(msg.cardsV2).toEqual([{ cardId: 'c1' }]);
    expect(msg.annotations).toEqual([{ type: 'USER_MENTION' }]);
    expect(msg.attachedGifs).toEqual([{ uri: 'https://gif' }]);
  });

  test('a plain text message gains no empty arrays', () => {
    const msg = mapChatMessage({ name: 'n', createTime: 't', text: 'hi' }, undefined);
    expect(Object.keys(msg).sort()).toEqual(['createTime', 'name', 'sender', 'text', 'updateTime']);
  });
});

describe('text output markers', () => {
  const textless: GChatMessage = {
    name: 'spaces/S/messages/M.M', createTime: '2026-10-01T10:00:00Z', updateTime: 'x',
    sender: { name: 'users/1', displayName: 'Ann' },
    attachment: [UPLOAD, DRIVE],
    cardsV2: [{}],
  };

  test('messageMarkers names each attachment and its type', () => {
    expect(messageMarkers(textless)).toEqual([
      '[attachment: photo.jpg (image/jpeg)]',
      '[attachment: Plan (application/vnd.google-apps.document, drive)]',
      '[cards: 1]',
    ]);
  });

  test('list and get show the markers for a text-less message', () => {
    const list = captureLog(() => printGChatMessageList([textless]));
    expect(list).toContain('[attachment: photo.jpg (image/jpeg)]');
    const one = captureLog(() => printGChatMessage(textless));
    expect(one).toContain('[attachment: photo.jpg (image/jpeg)]');
    expect(one).toContain(`Download: agentio gchat download ${UPLOAD.name}`);
  });
});

describe('file names', () => {
  test('sanitize strips separators, control characters and leading dots', () => {
    expect(sanitizeFilenamePart('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilenamePart('a\u0000b\nc:d*e?.png')).toBe('abc_d_e_.png');
    expect(sanitizeFilenamePart('  spaced   out  ')).toBe('spaced out');
  });

  test('sanitize bounds the length but keeps the extension', () => {
    const long = sanitizeFilenamePart('x'.repeat(300) + '.pdf', 50);
    expect(long.length).toBe(50);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  test('build uses <date>_<sender>_<contentName>', () => {
    expect(buildAttachmentFilename('2026-10-01T10:00:00Z', 'Ann Lee', 'photo.jpg')).toBe('2026-10-01_Ann-Lee_photo.jpg');
    expect(buildAttachmentFilename('garbage', 'a/b', '')).toBe('unknown-date_a_b_attachment');
  });

  test('dedupe adds (2), (3) before the extension, ignoring case', () => {
    const used = new Set<string>();
    expect(dedupeFilename('a.jpg', used)).toBe('a.jpg');
    expect(dedupeFilename('A.JPG', used)).toBe('A (2).JPG');
    expect(dedupeFilename('a.jpg', used)).toBe('a (3).jpg');
    expect(dedupeFilename('noext', used)).toBe('noext');
    expect(dedupeFilename('noext', used)).toBe('noext (2)');
  });
});

describe('download routing', () => {
  test('media URL keeps slashes and encodes the rest', () => {
    expect(mediaDownloadUrl('spaces/S/messages/M.M/attachments/A+b=')).toBe(
      'https://chat.googleapis.com/v1/media/spaces/S/messages/M.M/attachments/A%2Bb%3D?alt=media'
    );
  });

  test('kind: uploaded vs drive vs none', () => {
    expect(attachmentKind(UPLOAD)).toBe('uploaded');
    expect(attachmentKind(DRIVE)).toBe('drive');
    expect(attachmentKind({ name: 'x', source: 'DRIVE_FILE' })).toBe('none');
    expect(attachmentKind({ name: 'x' })).toBe('none');
  });

  test('Drive: real files use alt=media, Google Docs are exported, forms are refused', () => {
    expect(planDriveDownload('F', 'image/png').url).toBe(
      'https://www.googleapis.com/drive/v3/files/F?alt=media&supportsAllDrives=true'
    );
    const doc = planDriveDownload('F', 'application/vnd.google-apps.spreadsheet');
    expect(doc.extension).toBe('.xlsx');
    expect(doc.url).toBe(driveExportUrl('F', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    expect(() => planDriveDownload('F', 'application/vnd.google-apps.form')).toThrow(/form files cannot/);
  });

  test('an uploaded file is fetched from the Chat media API with the bearer token', async () => {
    const { calls, deps } = fakeFetch([['https://chat.googleapis.com/v1/media/', () => new Response('JPEG')]]);
    const { response } = await openAttachment(UPLOAD, deps);
    expect(await response.text()).toBe('JPEG');
    expect(calls).toEqual([{ url: mediaDownloadUrl(UPLOAD.attachmentDataRef!.resourceName!), auth: 'Bearer tok' }]);
  });

  test('a Google Doc in Drive is exported without a metadata lookup', async () => {
    const { calls, deps } = fakeFetch([['https://www.googleapis.com/drive/v3/files/drive-file-1/export', () => new Response('DOCX')]]);
    const { extension } = await openAttachment(DRIVE, deps);
    expect(extension).toBe('.docx');
    expect(calls.length).toBe(1);
  });

  test('a Drive file of unknown type asks Drive for its mimeType first', async () => {
    const { calls, deps } = fakeFetch([
      ['https://www.googleapis.com/drive/v3/files/drive-file-1?fields', () => Response.json({ mimeType: 'video/mp4' })],
      ['https://www.googleapis.com/drive/v3/files/drive-file-1?alt=media', () => new Response('MP4')],
    ]);
    const { response, extension } = await openAttachment({ ...DRIVE, contentType: undefined }, deps);
    expect(await response.text()).toBe('MP4');
    expect(extension).toBeUndefined();
    expect(calls.map(c => c.url.split('?')[1].split('&')[0])).toEqual(['fields=mimeType,name', 'alt=media']);
  });

  test('a 403 from Drive explains the reauth step', async () => {
    const { deps } = fakeFetch([['https://www.googleapis.com/drive/', () => new Response('{"error":{"message":"Insufficient scopes"}}', { status: 403 })]]);
    await expect(openAttachment(DRIVE, deps)).rejects.toThrow(/HTTP 403: Insufficient scopes.*agentio profile reauth gchat/);
  });

  test('a grant known to lack Drive fails fast, without a request', async () => {
    const { calls, deps } = fakeFetch([]);
    await expect(openAttachment(DRIVE, { ...deps, driveAllowed: false })).rejects.toThrow(/without Drive access/);
    expect(calls).toEqual([]);
  });

  test('grantAllowsDrive reads the stored scope string', () => {
    expect(grantAllowsDrive(undefined)).toBe(true);
    expect(grantAllowsDrive('https://www.googleapis.com/auth/chat.messages.readonly')).toBe(false);
    expect(grantAllowsDrive('a https://www.googleapis.com/auth/drive.readonly b')).toBe(true);
    expect(grantAllowsDrive('https://www.googleapis.com/auth/drive.file')).toBe(false);
  });

  test('gchat asks for read-only Drive access and nothing broader', () => {
    expect(SCOPES.gchat).toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(SCOPES.gchat).not.toContain('https://www.googleapis.com/auth/drive');
    expect(SCOPES.gchat).toContain('https://www.googleapis.com/auth/chat.messages.readonly');
  });
});

describe('manifest CSV', () => {
  test('quotes commas, quotes and newlines', () => {
    const csv = manifestToCsv([{
      messageName: 'm', createTime: 't', sender: 'Lee, Ann', attachmentName: 'a', contentName: 'say "hi"\n.txt',
      contentType: 'text/plain', source: 'UPLOADED_CONTENT', savedPath: '/x', status: 'saved', bytes: 3,
    }]);
    const [header, row] = csv.split('\n');
    expect(header).toBe('messageName,createTime,sender,senderEmail,attachmentName,contentName,contentType,source,savedPath,status,bytes,error');
    expect(csv).toContain('"Lee, Ann"');
    expect(csv).toContain('"say ""hi""\n.txt"');
    expect(row.startsWith('m,t,"Lee, Ann",,a,')).toBe(true);
  });
});

describe('exportAttachments', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agentio-gchat-att-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function* messages(list: GChatMessage[]) { for (const m of list) yield m; }
  const base = { updateTime: 'x', sender: { name: 'users/1', displayName: 'Ann Lee', email: 'ann@example.com' } };
  const sample: GChatMessage[] = [
    { ...base, name: 'spaces/S/messages/T', createTime: '2026-10-01T09:00:00Z', text: 'no files' },
    { ...base, name: 'spaces/S/messages/M1', createTime: '2026-10-01T10:00:00Z', attachment: [UPLOAD, { ...UPLOAD, name: 'spaces/S/messages/M1/attachments/A9' }] },
    { ...base, name: 'spaces/S/messages/M2', createTime: '2026-10-02T10:00:00Z', attachment: [DRIVE, { name: 'spaces/S/messages/M2/attachments/A3', contentName: 'broken.bin', attachmentDataRef: { resourceName: 'BROKEN' } }] },
  ];

  test('saves files, dedupes names, records a failure and keeps going, writes both manifests', async () => {
    const { deps } = fakeFetch([
      ['https://chat.googleapis.com/v1/media/BROKEN', () => new Response('boom', { status: 500 })],
      ['https://chat.googleapis.com/v1/media/', () => new Response('JPEG')],
      ['https://www.googleapis.com/drive/v3/files/drive-file-1/export', () => new Response('DOCX')],
    ]);
    const progress: number[] = [];
    const result = await exportAttachments(messages(sample), { outDir: dir, onProgress: (_e, i) => progress.push(i) }, deps);

    expect(result).toMatchObject({ messagesScanned: 3, messagesWithAttachments: 2, attachments: 4, saved: 3, failed: 1 });
    expect(progress.sort()).toEqual([0, 1, 2, 3]);
    expect((await readdir(dir)).sort()).toEqual([
      '2026-10-01_Ann-Lee_photo (2).jpg',
      '2026-10-01_Ann-Lee_photo.jpg',
      '2026-10-02_Ann-Lee_Plan.docx',
      'manifest.csv',
      'manifest.json',
    ]);
    expect(await readFile(join(dir, '2026-10-02_Ann-Lee_Plan.docx'), 'utf-8')).toBe('DOCX');

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));
    expect(manifest).toHaveLength(4);
    const failed = manifest.find((e: { contentName: string }) => e.contentName === 'broken.bin');
    expect(failed).toMatchObject({ status: 'failed', messageName: 'spaces/S/messages/M2', senderEmail: 'ann@example.com', error: 'HTTP 500' });
    const saved = manifest.find((e: { attachmentName: string }) => e.attachmentName === UPLOAD.name);
    expect(saved).toMatchObject({ status: 'saved', bytes: 4, source: 'UPLOADED_CONTENT', savedPath: join(dir, '2026-10-01_Ann-Lee_photo.jpg') });

    const csv = await readFile(join(dir, 'manifest.csv'), 'utf-8');
    expect(csv.trim().split('\n')).toHaveLength(5);
  });

  test('dry run downloads nothing and still writes the manifest', async () => {
    const { calls, deps } = fakeFetch([]);
    const result = await exportAttachments(messages(sample), { outDir: dir, dryRun: true }, deps);
    expect(calls).toEqual([]);
    expect(result.entries.every(e => e.status === 'planned')).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['manifest.csv', 'manifest.json']);
  });
});

describe('GChatClient with a fake Chat API', () => {
  function fakeClient(chat: unknown) {
    const client = new GChatClient({ type: 'oauth', accessToken: 'a', tokenType: 'Bearer', email: '' });
    const auth = { getAccessToken: async () => ({ token: null }) };
    (client as unknown as { getOAuthChatApi: () => unknown }).getOAuthChatApi = () => ({ auth, chat });
    return client;
  }

  test('get accepts spaces/ prefixed space ids and full message names, and returns attachments', async () => {
    const requested: string[] = [];
    const client = fakeClient({
      spaces: {
        get: async ({ name }: { name: string }) => { requested.push(name); return { data: { name } }; },
        messages: {
          get: async ({ name }: { name: string }) => {
            requested.push(name);
            return { data: { name, createTime: '2026-10-01T10:00:00Z', attachment: [UPLOAD] } };
          },
        },
      },
    });
    const msg = await client.get({ spaceId: 'spaces/AAAAU78G66k', messageId: 'spaces/AAAAU78G66k/messages/IJI.IJI' });
    expect(requested).toEqual(['spaces/AAAAU78G66k', 'spaces/AAAAU78G66k/messages/IJI.IJI']);
    expect(msg.attachment?.[0].contentName).toBe('photo.jpg');
  });

  test('iterateMessages pages through the whole space, oldest first', async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const pages: Record<string, { messages: unknown[]; nextPageToken?: string }> = {
      first: { messages: [{ name: 'm1', createTime: '1' }], nextPageToken: 'p2' },
      p2: { messages: [{ name: 'm2', createTime: '2', attachment: [UPLOAD] }] },
    };
    const client = fakeClient({
      spaces: {
        get: async ({ name }: { name: string }) => ({ data: { name } }),
        messages: {
          list: async (params: Record<string, unknown>) => {
            listCalls.push(params);
            return { data: pages[(params.pageToken as string) || 'first'] };
          },
        },
      },
    });
    const names: string[] = [];
    for await (const m of client.iterateMessages({ spaceId: 'spaces/S', since: new Date('2026-01-01T00:00:00Z') })) names.push(m.name);
    expect(names).toEqual(['m1', 'm2']);
    expect(listCalls.map(c => c.pageToken)).toEqual([undefined, 'p2']);
    expect(listCalls[0]).toMatchObject({ parent: 'spaces/S', orderBy: 'createTime asc', pageSize: 1000, filter: 'createTime > "2026-01-01T00:00:00.000Z"' });
  });
});

describe('parseDateOption', () => {
  test('refuses dates that do not parse', () => {
    expect(parseDateOption(undefined, '--since')).toBeUndefined();
    expect(parseDateOption('2026-04-01', '--since')?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(() => parseDateOption('yesterday-ish', '--since')).toThrow(/Invalid --since date/);
  });
});
