import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SlackClient } from '../../../src/plugins/slack/client';
import {
  canvasIdFrom, checkAccessLevel, findCanvases, readCanvas, resolveCanvasId, resolveTargets,
} from '../../../src/plugins/slack/canvases';
import { caught, FakeSlack, fakeChannel, rawUser, TOKEN } from './fake-slack';

const FIXTURE = readFileSync(join(import.meta.dir, 'fixtures', 'canvas.html'), 'utf-8');

let fake: FakeSlack;
let client: SlackClient;

beforeEach(() => {
  fake = new FakeSlack();
  fake.users = [rawUser('U0ADMIN', { profile: { display_name: 'admin' } }), rawUser('U0001', { profile: { display_name: 'alice', email: 'alice@example.com' } })];
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
});

afterEach(() => fake.stop());

const methods = () => fake.log.map((c) => c.url.replace('https://slack.com/api/', ''));

describe('canvasIdFrom', () => {
  test('an id, a docs link and a files link give the id; extra query strings and slashes do not matter', () => {
    expect(canvasIdFrom(' F0CANVAS01 ')).toBe('F0CANVAS01');
    expect(canvasIdFrom('https://example.slack.com/docs/T0001/F0CANVAS01')).toBe('F0CANVAS01');
    expect(canvasIdFrom('https://example.slack.com/docs/T0001/F0CANVAS01/?focus=abc#x')).toBe('F0CANVAS01');
    expect(canvasIdFrom('https://example.slack.com/files/U0001/F0CANVAS01/plan')).toBe('F0CANVAS01');
  });

  test('links on other hosts, other Slack pages, lowercase ids and channel names give nothing', () => {
    for (const no of [
      'https://slack.com.evil.test/docs/T0001/F0CANVAS01',
      'https://evil.test/example.slack.com/docs/T0001/F0CANVAS01',
      'http://example.slack.com/docs/T0001/F0CANVAS01',
      'https://example.slack.com/archives/C0GENERAL/p1700000000000100',
      'f0canvas01',
      '#general',
      'F0',
    ]) {
      expect(canvasIdFrom(no)).toBeUndefined();
    }
  });
});

describe('resolveCanvasId', () => {
  test('a #channel or channel id gives its canvas', async () => {
    fake.channels.push(fakeChannel('C0DOCS', 'docs', { canvas: 'F0CANVAS09' }));
    expect(await resolveCanvasId(client, '#docs')).toBe('F0CANVAS09');
    expect(await resolveCanvasId(client, 'C0DOCS')).toBe('F0CANVAS09');
  });

  test('a channel without a canvas is NOT_FOUND, suggesting how to create one', async () => {
    const err = await caught(resolveCanvasId(client, '#general'));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.suggestion).toContain('canvases create --channel general');
  });

  test('a channel that does not exist, or a private one you are not in, is NOT_FOUND', async () => {
    fake.channels.push(fakeChannel('G0SECRET', 'secret', { is_private: true, members: ['U0001'], canvas: 'F0CANVAS08' }));
    expect((await caught(resolveCanvasId(client, '#nope'))).code).toBe('NOT_FOUND');
    expect((await caught(resolveCanvasId(client, '#secret'))).code).toBe('NOT_FOUND');
  });

  test('anything else is INVALID_PARAMS, before any API call', async () => {
    expect((await caught(resolveCanvasId(client, 'my plan'))).code).toBe('INVALID_PARAMS');
    expect(fake.log).toEqual([]);
  });
});

describe('readCanvas', () => {
  test('a real canvas comes back as Markdown, with what cannot be written back listed', async () => {
    const canvas = fake.addCanvas({ title: 'Test', html: FIXTURE });
    const content = await readCanvas(client, canvas.id);
    expect(content).toMatchObject({ id: canvas.id, title: 'Test', owner: 'U0ADMIN' });
    expect(content.markdown).toContain('- [x] todo 1');
    expect(content.unconverted).toHaveLength(4);
    expect(content).not.toHaveProperty('downloadUrl');
  });

  test('a file that is not a canvas is NOT_FOUND, without a download', async () => {
    fake.otherFiles.push({ id: 'F0PDF00001', filetype: 'pdf', title: 'report.pdf', user: 'U0001' });
    expect((await caught(readCanvas(client, 'F0PDF00001'))).code).toBe('NOT_FOUND');
    expect(fake.log.some((c) => c.url.startsWith('https://files.slack.com/'))).toBe(false);
  });
});

describe('findCanvases', () => {
  test('newest edit first, owners named, an owner who is gone shown by id', async () => {
    fake.addCanvas({ title: 'Old', updated: 1792000000 });
    fake.addCanvas({ title: 'New', user: 'U0001', updated: 1793000000 });
    fake.addCanvas({ title: 'Orphan', user: 'U0GONE001', updated: 1792500000 });
    const canvases = await findCanvases(client, {});
    expect(canvases.map((c) => [c.title, c.ownerName])).toEqual([['New', 'alice'], ['Orphan', 'U0GONE001'], ['Old', 'admin']]);
  });

  test('--mine asks Slack for your canvases only', async () => {
    fake.addCanvas({ title: 'Mine' });
    fake.addCanvas({ title: 'Theirs', user: 'U0001' });
    expect((await findCanvases(client, { mine: true })).map((c) => c.title)).toEqual(['Mine']);
    expect(fake.log.find((c) => c.url.endsWith('files.list'))?.params.user).toBe('U0ADMIN');
  });

  test('--channel gives that channel\'s canvas only, or nothing', async () => {
    const canvas = fake.addCanvas({ title: 'Docs', channel: 'C0DOCS' });
    fake.addCanvas({ title: 'Other' });
    fake.channels.push(fakeChannel('C0DOCS', 'docs', { canvas: canvas.id }));
    expect((await findCanvases(client, { channel: '#docs' })).map((c) => c.title)).toEqual(['Docs']);
    expect(await findCanvases(client, { channel: '#general' })).toEqual([]);
    expect(methods()).not.toContain('files.list');
  });
});

describe('resolveTargets and checkAccessLevel', () => {
  test('users by id or email and channels by #name or id are split, each once', async () => {
    const targets = await resolveTargets(client, ['U0001,#general', 'alice@example.com', 'C0RANDOM']);
    expect(targets).toEqual({ users: ['U0001'], channels: ['C0GENERAL', 'C0RANDOM'] });
  });

  test('an unknown email or channel is NOT_FOUND; anything else is INVALID_PARAMS; nothing at all is INVALID_PARAMS', async () => {
    expect((await caught(resolveTargets(client, ['nobody@example.com']))).code).toBe('NOT_FOUND');
    expect((await caught(resolveTargets(client, ['#nope']))).code).toBe('NOT_FOUND');
    expect((await caught(resolveTargets(client, ['alice']))).code).toBe('INVALID_PARAMS');
    expect((await caught(resolveTargets(client, [' , ']))).code).toBe('INVALID_PARAMS');
  });

  test('levels are read, write or owner; read by default', () => {
    expect(checkAccessLevel(undefined)).toBe('read');
    expect(checkAccessLevel('write')).toBe('write');
    for (const bad of ['admin', 'READ', '', 'edit']) expect(() => checkAccessLevel(bad)).toThrow();
  });
});
