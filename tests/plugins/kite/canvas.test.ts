import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { KiteClient } from '../../../src/plugins/kite/client';
import { KiteCanvas, parseOpsText } from '../../../src/plugins/kite/canvas';
import { FakeKite, caught } from './fake-kite';

const ME = 'me@example.com';
let fake: FakeKite;
let token: string;
let canvas: KiteCanvas;

const BOARD = JSON.stringify({
  nodes: [
    { id: 'n1', type: 'text', text: 'Ship it', x: 0, y: 0, width: 260, height: 140 },
    { id: 'n2', type: 'link', url: 'https://jsoncanvas.org', x: 400, y: 0, width: 260, height: 140, kite: { createdAt: '2026-01-01T00:00:00Z' } },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
});

beforeEach(() => {
  fake = new FakeKite();
  token = fake.issueToken(ME);
  canvas = new KiteCanvas(new KiteClient({ baseUrl: fake.url, token }));
});

afterEach(() => fake.stop());

function seedCanvas() {
  return fake.seedDoc(ME, { type: 'canvas', content: BOARD, title: 'Board' });
}

function clean(text: string) {
  expect(text).not.toContain(token);
  expect(text.toLowerCase()).not.toContain('artifact');
}

describe('reading', () => {
  test('get has the version, by id or link; strict leaves out Kite\'s keys and still knows the version', async () => {
    const doc = seedCanvas();
    const full = await canvas.get(`${fake.url}/a/${doc.slug}`);
    expect(full).toMatchObject({ id: doc.id, version: 1 });
    expect(full.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(full.nodes[1].kite).toBeDefined();
    expect(full).not.toHaveProperty('kite');

    const strict = await canvas.get(doc.id, { strict: true });
    expect(strict.version).toBe(1);
    expect(strict.nodes[1]).not.toHaveProperty('kite');
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/canvas`).at(-1)!.query).toEqual({ format: 'jsoncanvas-strict' });
  });

  test('outline passes frame and depth, and gives the version', async () => {
    const doc = seedCanvas();
    const outline = await canvas.outline(doc.id, { depth: 2 });
    expect(outline).toMatchObject({ id: doc.id, version: 1, counts: { nodes: 2, edges: 1, groups: 0 } });
    expect(outline).not.toHaveProperty('docId');
    expect(outline.tree.map((n) => n.summary)).toEqual(['Ship it', 'https://jsoncanvas.org']);
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/canvas/outline`)[0].query).toEqual({ depth: '2' });
  });

  test('a Markdown document is not a canvas, and says how to read it', async () => {
    const doc = fake.seedDoc(ME);
    const e = await caught(canvas.outline(doc.id));
    expect(e.message).toContain('not a canvas');
    clean(`${e.message} ${e.suggestion ?? ''}`);
  });

  test('a Kite without canvases says so, for reads, writes and create', async () => {
    fake.canvasApi = false;
    const doc = fake.seedDoc(ME);
    for (const call of [
      () => canvas.get(doc.id), () => canvas.outline(doc.id),
      () => canvas.ops(doc.id, [{ op: 'move', id: 'n1', x: 0, y: 0 }], { baseVersion: 1 }),
      () => canvas.create({ content: BOARD, description: 'D.', summary: 'S.' }),
    ]) {
      const e = await caught(call());
      expect(e.message).toBe(`Kite at ${fake.url} does not have canvases yet`);
      expect(e.suggestion).toContain('Kite 1.4.0 or later');
    }
  });
});

describe('changing', () => {
  test('create sends a canvas, with the description and summary', async () => {
    const doc = await canvas.create({ content: BOARD, title: 'Board', description: 'What ships.', summary: 'Two nodes.' });
    expect(doc).toMatchObject({ type: 'canvas', title: 'Board', version: 1 });
    expect(fake.requests('POST', '/api/artifacts')[0].body).toEqual({ type: 'canvas', content: BOARD, title: 'Board', description: 'What ships.', summary: 'Two nodes.' });
  });

  test('a batch is one version and names the new ids', async () => {
    const doc = seedCanvas();
    const result = await canvas.ops(doc.id, [
      { op: 'add', tempId: 'q', near: 'n1', side: 'bottom', node: { type: 'text', text: 'Open question' } },
      { op: 'connect', from: 'n1', to: 'q', label: 'asks' },
    ], { baseVersion: 1 });
    expect(result).toMatchObject({ id: doc.id, version: 2, dryRun: false });
    expect(Object.keys(result.ids)).toEqual(['q']);
    expect(doc.history.length).toBe(2);
    const sent = fake.requests('POST', `/api/artifacts/${doc.id}/canvas/ops`)[0].body as any;
    expect(sent.baseVersion).toBe(1);
    expect(sent).not.toHaveProperty('dryRun');
  });

  test('without a version, the current one is read first', async () => {
    const doc = seedCanvas();
    fake.seedEdit(doc, BOARD);
    const result = await canvas.ops(doc.id, [{ op: 'move', id: 'n1', x: 10, y: 20 }]);
    expect(result.version).toBe(3);
    expect((fake.requests('POST')[0].body as any).baseVersion).toBe(2);
  });

  test('a dry run changes nothing', async () => {
    const doc = seedCanvas();
    const result = await canvas.ops(doc.id, [{ op: 'delete', id: 'n2' }], { baseVersion: 1, dryRun: true });
    expect(result).toMatchObject({ version: 1, dryRun: true });
    expect(doc.version).toBe(1);
    expect((fake.requests('POST')[0].body as any).dryRun).toBe(true);
  });

  test('a stale version is refused with which version to read and resend against', async () => {
    const doc = seedCanvas();
    fake.seedEdit(doc, BOARD);
    fake.seedEdit(doc, BOARD);
    const e = await caught(canvas.ops(doc.id, [{ op: 'move', id: 'n1', x: 0, y: 0 }], { baseVersion: 1 }));
    expect(e.code).toBe('API_ERROR');
    expect(e.message).toBe(`The canvas ${doc.id} changed since version 1: it is at version 3 now`);
    expect(e.suggestion).toContain(`agentio kite canvas outline ${doc.id}`);
    expect(e.suggestion).toContain('--base-version 3');
    expect(e.suggestion).toContain('Nothing was changed');
    expect(doc.version).toBe(3);
    clean(`${e.message} ${e.suggestion}`);
  });

  test('an operation Kite refuses says which one, and nothing is applied', async () => {
    const doc = seedCanvas();
    const e = await caught(canvas.ops(doc.id, [{ op: 'move', id: 'n1', x: 5, y: 5 }, { op: 'disconnect', id: 'e9' }], { baseVersion: 1 }));
    expect(e.message).toContain('Operation 2 (disconnect)');
    expect(doc.version).toBe(1);
  });
});

describe('versions', () => {
  test('a version reads as a canvas and is not recorded', async () => {
    const doc = seedCanvas();
    await canvas.ops(doc.id, [{ op: 'delete', id: 'n2' }], { baseVersion: 1 });
    const old = await canvas.version(doc.id, 1);
    expect(old).toMatchObject({ id: doc.id, version: 1, currentVersion: 2, current: false, title: 'Board' });
    expect(old.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/versions/1`)[0].query).toEqual({ record: 'false' });
    expect(doc.opens.length).toBe(0);
  });

  test('a Markdown version is pointed at versions get', async () => {
    const doc = fake.seedDoc(ME);
    const e = await caught(canvas.version(doc.id, 1));
    expect(e.suggestion).toBe(`Read it with: agentio kite versions get ${doc.id} 1`);
  });

  test('restore writes the old content as a new version, against the current one', async () => {
    const doc = seedCanvas();
    await canvas.ops(doc.id, [{ op: 'delete', id: 'n2' }], { baseVersion: 1 });
    const restored = await canvas.restore(doc.id, 1);
    expect(restored).toMatchObject({ id: doc.id, version: 3, restoredFrom: 1 });
    expect(doc.content).toBe(BOARD);
    expect(fake.requests('PUT')[0].body).toEqual({ type: 'canvas', content: BOARD, baseVersion: 2 });
  });

  test('restore against a stale version says to run it again', async () => {
    const doc = seedCanvas();
    fake.seedEdit(doc, BOARD);
    const e = await caught(canvas.restore(doc.id, 1, 1));
    expect(e.message).toContain('changed since version 1');
    expect(e.suggestion).toBe(`Nothing was changed. Run it again: agentio kite canvas restore ${doc.id} 1`);
  });
});

describe('parseOpsText', () => {
  test('a list, or an object carrying its version', () => {
    expect(parseOpsText('[{"op":"move","id":"n1","x":0,"y":0}]', 'f')).toEqual({ ops: [{ op: 'move', id: 'n1', x: 0, y: 0 }], baseVersion: undefined });
    expect(parseOpsText('{"baseVersion":4,"ops":[{"op":"delete","id":"n1"}]}', 'f').baseVersion).toBe(4);
  });

  test('refuses what is not a list of operations', () => {
    for (const bad of ['nope', '[]', '{"ops":[]}', '[{"id":"n1"}]', '{"baseVersion":0,"ops":[{"op":"delete"}]}']) {
      expect(() => parseOpsText(bad, 'f')).toThrow();
    }
  });
});
