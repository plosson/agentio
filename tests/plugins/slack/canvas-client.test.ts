import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { checkDownloadUrl, SlackClient } from '../../../src/plugins/slack/client';
import { caught, FakeSlack, fakeChannel, TOKEN } from './fake-slack';

let fake: FakeSlack;
let client: SlackClient;

beforeEach(() => {
  fake = new FakeSlack();
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
});

afterEach(() => fake.stop());

/** Requests that went anywhere but Slack's two hosts. */
const elsewhere = () => fake.log.filter((c) => !c.url.startsWith('https://slack.com/api/') && !c.url.startsWith('https://files.slack.com/'));

describe('checkDownloadUrl', () => {
  test('only https://files.slack.com on the default port is accepted', () => {
    expect(checkDownloadUrl('https://files.slack.com/files-pri/T1-F1/download')).toBe('https://files.slack.com/files-pri/T1-F1/download');
    for (const bad of [
      'http://files.slack.com/files-pri/T1-F1/download',
      'https://files.slack.com.evil.test/x',
      'https://evil.test/files.slack.com/x',
      'https://user:pw@files.slack.com/x',
      'https://files.slack.com:8443/x',
      'https://slack.com/x',
      'not a url',
      undefined,
      42,
    ]) {
      expect(() => checkDownloadUrl(bad)).toThrow();
    }
  });
});

describe('canvasInfo and downloadCanvasHtml', () => {
  test('a canvas gives its title, owner, link and HTML', async () => {
    const canvas = fake.addCanvas({ title: 'Plan', html: '<div class="quip-canvas-content"><h1>Plan</h1></div>' });
    const { canvas: info, html } = await client.canvasHtml(canvas.id);
    expect(info).toMatchObject({ id: canvas.id, title: 'Plan', owner: 'U0ADMIN', link: `https://example.slack.com/docs/T0001/${canvas.id}` });
    expect(html).toContain('<h1>Plan</h1>');
    expect(await client.canvasInfo(canvas.id)).toEqual(info);
  });

  test('a download link on another host never receives the token, and nothing is fetched', async () => {
    fake.downloadUrlFor = () => 'https://files.slack.com.evil.test/x';
    const canvas = fake.addCanvas({ title: 'Plan' });
    const err = await caught(client.canvasHtml(canvas.id));
    expect(err.code).toBe('API_ERROR');
    expect(elsewhere()).toEqual([]);
  });

  test('a file that is not a canvas, and an unknown id, are NOT_FOUND', async () => {
    fake.otherFiles.push({ id: 'F0PDF00001', filetype: 'pdf', title: 'report.pdf', user: 'U0001' });
    expect((await caught(client.canvasInfo('F0PDF00001'))).code).toBe('NOT_FOUND');
    expect((await caught(client.canvasInfo('F0NOPE0001'))).code).toBe('NOT_FOUND');
  });

  test('download errors map to codes; a body that is not HTML is an error, not an empty canvas', async () => {
    const url = 'https://files.slack.com/files-pri/T0001-F1/download';
    for (const [status, code] of [[401, 'PERMISSION_DENIED'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [500, 'API_ERROR']] as const) {
      fake.downloadAnswer = { status };
      expect((await caught(client.downloadCanvasHtml(url))).code).toBe(code);
    }
    fake.downloadAnswer = { status: 200, contentType: 'application/json', body: '{"ok":false}' };
    expect((await caught(client.downloadCanvasHtml(url))).code).toBe('API_ERROR');
  });

  test('a missing files:read fails naming it', async () => {
    fake.scopes.delete('files:read');
    const err = await caught(client.canvasInfo('F0CANVAS01'));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('files:read');
  });
});

describe('listCanvases', () => {
  test('every page is read, even pages with no canvas on them', async () => {
    fake.filesPageSize = 2;
    for (let i = 0; i < 5; i++) fake.otherFiles.push({ id: `F0OTHER0${i}`, filetype: 'png', user: 'U0001' });
    fake.addCanvas({ title: 'Last' });
    const { canvases, truncated } = await client.listCanvases();
    expect(canvases.map((c) => c.title)).toEqual(['Last']);
    expect(truncated).toBe(false);
    expect(fake.log.map((c) => c.params.page)).toEqual(['1', '2', '3']);
    expect(fake.log.every((c) => c.params.types === 'canvas')).toBe(true);
  });

  test('a user filter is passed to Slack', async () => {
    fake.addCanvas({ title: 'Mine' });
    fake.addCanvas({ title: 'Theirs', user: 'U0001' });
    expect((await client.listCanvases({ user: 'U0ADMIN' })).canvases.map((c) => c.title)).toEqual(['Mine']);
  });
});

describe('channelCanvasIds', () => {
  test('a channel\'s canvases come from its canvas tabs, and from the documented field, each once', async () => {
    fake.channels.push(
      fakeChannel('C0DOCS', 'docs', { canvas: 'F0CANVAS09' }),
      fakeChannel('C0TABS', 'tabs', { tabs: [{ type: 'canvas', file_id: 'F0CANVAS07' }, { type: 'list', file_id: 'F0LIST0001' }, { type: 'canvas' }] }),
      fakeChannel('C0BOTH', 'both', { canvas: 'F0CANVAS05', tabs: [{ type: 'canvas', file_id: 'F0CANVAS05' }, { type: 'canvas', file_id: 'F0CANVAS06' }] }),
    );
    expect(await client.channelCanvasIds('C0DOCS')).toEqual(['F0CANVAS09']);
    expect(await client.channelCanvasIds('C0TABS')).toEqual(['F0CANVAS07']);
    expect(await client.channelCanvasIds('C0BOTH')).toEqual(['F0CANVAS05', 'F0CANVAS06']);
    expect(await client.channelCanvasIds('C0GENERAL')).toEqual([]);
  });
});

describe('review fixes', () => {
  const url = 'https://files.slack.com/files-pri/T0001-F1/download';

  test('a redirect is reported as an access problem, not a network one', async () => {
    fake.downloadAnswer = { status: 302 };
    const err = await caught(client.downloadCanvasHtml(url));
    expect(err.code).toBe('PERMISSION_DENIED');
  });

  test('a list cut at the page limit says so', async () => {
    fake.filesPageSize = 1;
    fake.addCanvas({ title: 'First' });
    for (let i = 0; i < 100; i++) fake.otherFiles.push({ id: `F0OTHER${String(i).padStart(3, '0')}`, filetype: 'png', user: 'U0001' });
    const result = await client.listCanvases();
    expect(result.canvases.map((c) => c.title)).toEqual(['First']);
    expect(result.truncated).toBe(true);
  });

  test('more than 20 users are shared in batches of 20', async () => {
    const canvas = fake.addCanvas({ title: 'Plan' });
    const users = Array.from({ length: 25 }, (_, i) => `U0X${String(i).padStart(4, '0')}`);
    await client.setCanvasAccess(canvas.id, 'read', { users, channels: [] });
    expect(fake.accessCalls.map((c) => JSON.parse(c.params.user_ids).length)).toEqual([20, 5]);
  });

  test('a failure after some access was given names who already has it', async () => {
    const canvas = fake.addCanvas({ title: 'Plan' });
    fake.accessErrors.C0BAD = 'channel_not_found';
    const err = await caught(client.setCanvasAccess(canvas.id, 'read', { users: ['U0001'], channels: ['C0BAD'] }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('U0001');
    expect(canvas.access).toEqual({ U0001: 'read' });
  });
});
