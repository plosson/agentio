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
  scope: 'https://www.googleapis.com/auth/documents',
  email: 'owner@example.com',
};

const DOC_ID = '1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789';

interface UpdateCall {
  fileId: string;
  requestBody?: Record<string, unknown>;
  media: { mimeType: string; body: Readable };
}

function tab(tabId: string, childTabs: unknown[] = []) {
  return { tabProperties: { tabId, title: tabId }, childTabs };
}

/** A client whose Drive and Docs calls are recorded instead of sent. */
function stubbedClient(tabs: unknown[] = [tab('t.0')]) {
  const client = new GDocsClient(CREDENTIALS);
  const calls = { update: [] as UpdateCall[], get: 0 };

  (client as any).docsApi.documents.get = async () => {
    calls.get++;
    return { data: { tabs } };
  };
  (client as any).drive.files.update = async (opts: UpdateCall) => {
    calls.update.push(opts);
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

describe('gdocs updateFromMarkdown guards', () => {
  test.each(['', '   ', '\n\n\t'])('refuses empty content %p without touching the API', async (markdown) => {
    const { client, calls } = stubbedClient();

    const err = await rejection(client.updateFromMarkdown(DOC_ID, markdown));

    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.suggestion).toContain('--force');
    expect(calls.get).toBe(0);
    expect(calls.update).toHaveLength(0);
  });

  test('refuses a document with several top-level tabs', async () => {
    const { client, calls } = stubbedClient([tab('t.0'), tab('t.1')]);

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('2 tabs');
    expect(calls.update).toHaveLength(0);
  });

  test('counts nested child tabs, not only top-level ones', async () => {
    const { client, calls } = stubbedClient([tab('t.0', [tab('t.child')])]);

    await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(calls.update).toHaveLength(0);
  });

  test('--force skips the tab check and allows empty content', async () => {
    const { client, calls } = stubbedClient([tab('t.0'), tab('t.1')]);

    await client.updateFromMarkdown(DOC_ID, '', { force: true });

    expect(calls.get).toBe(0);
    expect(calls.update).toHaveLength(1);
    expect(await streamText(calls.update[0].media.body)).toBe('');
  });

  test('a tab lookup failure aborts before any write', async () => {
    const { client, calls } = stubbedClient();
    (client as any).docsApi.documents.get = async () => {
      throw Object.assign(new Error('nope'), { code: 404 });
    };

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('NOT_FOUND');
    expect(calls.update).toHaveLength(0);
  });
});

describe('gdocs updateFromMarkdown request', () => {
  test('rewrites the same file from a Docs URL, as Markdown media', async () => {
    const { client, calls } = stubbedClient();

    const result = await client.updateFromMarkdown(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`, '# New');

    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].fileId).toBe(DOC_ID);
    expect(calls.update[0].media.mimeType).toBe('text/markdown');
    expect(result.id).toBe(DOC_ID);
  });

  test('never renames the document unless a title is given', async () => {
    const { client, calls } = stubbedClient();

    await client.updateFromMarkdown(DOC_ID, '# New');
    await client.updateFromMarkdown(DOC_ID, '# New', { title: '' });
    await client.updateFromMarkdown(DOC_ID, '# New', { title: 'Renamed' });

    expect(calls.update[0].requestBody).toBeUndefined();
    expect(calls.update[1].requestBody).toBeUndefined();
    expect(calls.update[2].requestBody).toEqual({ name: 'Renamed' });
  });

  test('sends non-ASCII Markdown byte for byte', async () => {
    const { client, calls } = stubbedClient();
    const markdown = '# Café — 日本語 🚀\n\n> « citation »\n';

    await client.updateFromMarkdown(DOC_ID, markdown);

    expect(await streamText(calls.update[0].media.body)).toBe(markdown);
  });

  test('maps a Drive permission error to a CliError', async () => {
    const { client } = stubbedClient();
    (client as any).drive.files.update = async () => {
      throw Object.assign(new Error('forbidden'), { code: 403 });
    };

    const err = await rejection(client.updateFromMarkdown(DOC_ID, '# New'));

    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('update document');
  });
});
