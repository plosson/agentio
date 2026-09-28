import { describe, expect, test } from 'bun:test';
import type { Readable } from 'stream';
import { GDocsClient } from '../../../../src/plugins/google/gdocs/client';
import { CliError } from '../../../../src/utils/errors';
import type { GDocsCredentials } from '../../../../src/plugins/google/gdocs/types';

const CREDENTIALS: GDocsCredentials = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiryDate: Date.now() + 60_000,
  tokenType: 'Bearer',
  scope: 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive',
  email: 'owner@example.com',
};

const DOC_ID = '1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789';

// A replacement suggestion as the Docs API returns it: one ID on both the
// inserted and the deleted run.
const SUGGESTED_PARAGRAPH = {
  startIndex: 174,
  endIndex: 206,
  paragraph: {
    elements: [
      { startIndex: 174, endIndex: 190, textRun: { content: 'Very nice header', suggestedInsertionIds: ['suggest.djhy9w2a5i3c'] } },
      { startIndex: 190, endIndex: 197, textRun: { content: 'Heading', suggestedDeletionIds: ['suggest.djhy9w2a5i3c'] } },
      { startIndex: 197, endIndex: 206, textRun: { content: ' level 4\n' } },
    ],
  },
};

interface UpdateCall {
  fileId: string;
  requestBody?: Record<string, unknown>;
  media?: { mimeType: string; body: Readable };
}

interface DocShape {
  tabs?: unknown[];
  content?: unknown[];
  comments?: { resolved?: boolean }[][];
}

function tab(tabId: string, childTabs: unknown[] = [], content: unknown[] = []) {
  return { tabProperties: { tabId, title: tabId }, childTabs, documentTab: { body: { content } } };
}

function apiError(code: number, reason: string) {
  return Object.assign(new Error(reason), { code, response: { data: { error: { errors: [{ reason }] } } } });
}

/** A client whose Drive and Docs calls are recorded instead of sent. */
function stubbedClient(shape: DocShape = {}) {
  const client = new GDocsClient(CREDENTIALS);
  const tabs = shape.tabs ?? [tab('t.0', [], shape.content ?? [])];
  const pages = shape.comments ?? [[]];
  const calls = { probes: [] as UpdateCall[], writes: [] as UpdateCall[], gets: [] as Record<string, unknown>[], commentPages: 0 };

  (client as any).docsApi.documents.get = async (opts: Record<string, unknown>) => {
    calls.gets.push(opts);
    return { data: { suggestionsViewMode: 'SUGGESTIONS_INLINE', tabs } };
  };
  (client as any).drive.comments.list = async (opts: { pageToken?: string }) => {
    const index = opts.pageToken ? Number(opts.pageToken) : 0;
    calls.commentPages++;
    return {
      data: {
        comments: pages[index],
        nextPageToken: index + 1 < pages.length ? String(index + 1) : undefined,
      },
    };
  };
  (client as any).drive.files.update = async (opts: UpdateCall) => {
    (opts.media ? calls.writes : calls.probes).push(opts);
    return { data: { id: opts.fileId, name: 'Doc', webViewLink: `https://docs.google.com/document/d/${opts.fileId}/edit` } };
  };

  return { client, calls };
}

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('expected a rejection');
}

describe('gdocs updateFromMarkdown: empty content', () => {
  test.each(['', '   ', '\n\n\t'])('refuses %p without touching the API', async (markdown) => {
    const { client, calls } = stubbedClient();

    const err = await rejection(client.updateFromMarkdown(DOC_ID, markdown));

    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.suggestion).toContain('--force');
    expect(calls.gets).toHaveLength(0);
    expect(calls.probes).toHaveLength(0);
    expect(calls.writes).toHaveLength(0);
  });
});

describe('gdocs updateFromMarkdown: write access', () => {
  test('an old drive.file profile is refused with a reauth hint, and nothing is written', async () => {
    const { client, calls } = stubbedClient();
    (client as any).drive.files.update = async (opts: UpdateCall) => {
      if (opts.media) calls.writes.push(opts);
      throw apiError(403, 'appNotAuthorizedToFile');
    };

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.suggestion).toContain('agentio profile reauth gdocs');
    expect(calls.writes).toHaveLength(0);
  });

  test('--force never skips the write-access check', async () => {
    // Drive applies the content even while answering 403, so forcing past
    // the probe would change the document and still report a failure.
    const { client, calls } = stubbedClient();
    (client as any).drive.files.update = async (opts: UpdateCall) => {
      if (opts.media) calls.writes.push(opts);
      throw apiError(403, 'appNotAuthorizedToFile');
    };

    await rejection(client.updateFromMarkdown(DOC_ID, '# New', { force: true }));

    expect(calls.writes).toHaveLength(0);
  });

  test('a viewer or commenter gets an edit-access error, not a reauth hint', async () => {
    const { client } = stubbedClient();
    (client as any).drive.files.update = async () => {
      throw apiError(403, 'insufficientFilePermissions');
    };

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('edit access');
    expect(err.suggestion ?? '').not.toContain('reauth');
  });

  test('a missing document maps to NOT_FOUND before any write', async () => {
    const { client, calls } = stubbedClient();
    (client as any).drive.files.update = async (opts: UpdateCall) => {
      if (opts.media) calls.writes.push(opts);
      throw apiError(404, 'notFound');
    };

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('NOT_FOUND');
    expect(calls.writes).toHaveLength(0);
  });

  test('the probe is an empty metadata update: no content, no rename', async () => {
    const { client, calls } = stubbedClient();

    await client.updateFromMarkdown(DOC_ID, '# New', { title: 'Renamed' });

    expect(calls.probes).toHaveLength(1);
    expect(calls.probes[0].requestBody).toEqual({});
    expect(calls.probes[0].media).toBeUndefined();
  });
});

describe('gdocs updateFromMarkdown: what a replace would lose', () => {
  test('refuses a document with several top-level tabs', async () => {
    const { client, calls } = stubbedClient({ tabs: [tab('t.0'), tab('t.1')] });

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('2 tabs');
    expect(calls.writes).toHaveLength(0);
  });

  test('counts nested child tabs, not only top-level ones', async () => {
    const { client, calls } = stubbedClient({ tabs: [tab('t.0', [tab('t.child')])] });

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.message).toContain('2 tabs');
    expect(calls.writes).toHaveLength(0);
  });

  test('a replacement suggestion counts once, though its ID sits on two runs', async () => {
    const { client, calls } = stubbedClient({ content: [SUGGESTED_PARAGRAPH] });

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.message).toContain('1 pending suggestion ');
    expect(calls.writes).toHaveLength(0);
  });

  test('finds suggestions in a non-first tab and in style-change maps', async () => {
    const styled = { paragraph: { elements: [{ textRun: { content: 'x', suggestedTextStyleChanges: { 'suggest.style': { textStyle: { bold: true } } } } }] } };
    const { client } = stubbedClient({ tabs: [tab('t.0'), tab('t.1', [], [SUGGESTED_PARAGRAPH, styled])] });

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.message).toContain('2 pending suggestions');
  });

  test('suggestionsViewMode and empty suggestion fields are not suggestions', async () => {
    const plain = { paragraph: { elements: [{ textRun: { content: 'x', suggestedInsertionIds: [], suggestedTextStyleChanges: {} } }] } };
    const { client, calls } = stubbedClient({ content: [plain] });

    await client.updateFromMarkdown(DOC_ID, '# New');

    expect(calls.writes).toHaveLength(1);
  });

  test('asks the Docs API for every tab, with suggestions inline', async () => {
    const { client, calls } = stubbedClient();

    await client.updateFromMarkdown(DOC_ID, '# New');

    expect(calls.gets[0]).toMatchObject({ documentId: DOC_ID, includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' });
  });

  test('counts open comments across pages and ignores resolved ones', async () => {
    const { client, calls } = stubbedClient({
      comments: [[{ resolved: true }, {}], [{ resolved: false }, { resolved: true }], [{}]],
    });

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(calls.commentPages).toBe(3);
    expect(err.message).toContain('3 open comments');
    expect(calls.writes).toHaveLength(0);
  });

  test('only resolved comments do not block', async () => {
    const { client, calls } = stubbedClient({ comments: [[{ resolved: true }]] });

    await client.updateFromMarkdown(DOC_ID, '# New');

    expect(calls.writes).toHaveLength(1);
  });

  test('reports every kind of loss in one error', async () => {
    const { client } = stubbedClient({
      tabs: [tab('t.0', [], [SUGGESTED_PARAGRAPH]), tab('t.1')],
      comments: [[{}]],
    });

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.message).toContain('2 tabs');
    expect(err.message).toContain('1 pending suggestion');
    expect(err.message).toContain('1 open comment');
    expect(err.suggestion).toContain('--force');
  });

  test('--force skips the loss checks but still writes through the probe', async () => {
    const { client, calls } = stubbedClient({ tabs: [tab('t.0'), tab('t.1')], comments: [[{}]] });

    await client.updateFromMarkdown(DOC_ID, '', { force: true });

    expect(calls.gets).toHaveLength(0);
    expect(calls.commentPages).toBe(0);
    expect(calls.probes).toHaveLength(1);
    expect(calls.writes).toHaveLength(1);
    expect(await streamText(calls.writes[0].media!.body)).toBe('');
  });
});

describe('gdocs updateFromMarkdown: the write', () => {
  test('rewrites the same file from a Docs URL, as Markdown media', async () => {
    const { client, calls } = stubbedClient();

    const result = await client.updateFromMarkdown(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`, '# New');

    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0].fileId).toBe(DOC_ID);
    expect(calls.writes[0].media!.mimeType).toBe('text/markdown');
    expect(result.id).toBe(DOC_ID);
  });

  test('never renames the document unless a title is given', async () => {
    const { client, calls } = stubbedClient();

    await client.updateFromMarkdown(DOC_ID, '# New');
    await client.updateFromMarkdown(DOC_ID, '# New', { title: '' });
    await client.updateFromMarkdown(DOC_ID, '# New', { title: 'Renamed' });

    expect(calls.writes[0].requestBody).toBeUndefined();
    expect(calls.writes[1].requestBody).toBeUndefined();
    expect(calls.writes[2].requestBody).toEqual({ name: 'Renamed' });
  });

  test('sends non-ASCII Markdown byte for byte', async () => {
    const { client, calls } = stubbedClient();
    const markdown = '# Café — 日本語 🚀\n\n> « citation »\n';

    await client.updateFromMarkdown(DOC_ID, markdown);

    expect(await streamText(calls.writes[0].media!.body)).toBe(markdown);
  });

  test('maps a failed write to a CliError', async () => {
    const { client } = stubbedClient();
    (client as any).drive.files.update = async (opts: UpdateCall) => {
      if (opts.media) throw Object.assign(new Error('rate'), { code: 429 });
      return { data: { id: opts.fileId } };
    };

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('update document');
  });
});
