import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { KiteClient } from '../../../src/plugins/kite/client';
import { KiteCanvas } from '../../../src/plugins/kite/canvas';
import { kiteDeviceLogin } from '../../../src/plugins/kite/device-auth';
import { CliError } from '../../../src/utils/errors';
import { caught } from './fake-kite';

/**
 * Opt-in: the fake Kite (fake-kite.ts) checked against a real one. Runs only
 * with a local Kite dev server, never a deployed one:
 *
 *   cd open-artifact && SIGNUP_MODE=open BASE_URL=http://localhost:4010 PORT=4010 \
 *     SESSION_SECRET=$(openssl rand -hex 32) DATABASE_PATH=/tmp/kite-contract.db \
 *     pnpm --filter @open-artifact/server dev > /tmp/kite-contract.log
 *   KITE_CONTRACT_URL=http://localhost:4010 KITE_CONTRACT_LOG=/tmp/kite-contract.log \
 *     bun test tests/plugins/kite/contract.test.ts
 *
 * With no mail server, Kite prints sign-in codes to its output, which is how
 * this test signs a browser session in to approve the device code.
 */

const BASE = process.env.KITE_CONTRACT_URL?.replace(/\/+$/, '');
const LOG = process.env.KITE_CONTRACT_LOG;

function isLocal(url: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
}

if (BASE && !isLocal(BASE)) {
  throw new Error(`KITE_CONTRACT_URL must point at a local Kite, not ${BASE}`);
}

const run = BASE && LOG ? describe : describe.skip;

/** The last sign-in code the server printed for `email`. */
async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = readFileSync(LOG!, 'utf8');
    const matches = [...log.matchAll(/Email to: (\S+)\nSubject: +([0-9A-Z ]+?) is your/g)].filter((m) => m[1] === email);
    if (matches.length) return matches[matches.length - 1][2].replace(/\s/g, '');
    await Bun.sleep(100);
  }
  throw new Error(`no sign-in code for ${email} in ${LOG}`);
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

/** A browser session for `email`, as the approval page would have. */
async function browserSession(email: string): Promise<string> {
  const before = readFileSync(LOG!, 'utf8').length;
  expect((await post('/api/auth/code', { email })).status).toBe(200);
  while (readFileSync(LOG!, 'utf8').length === before) await Bun.sleep(50);
  const res = await post('/api/auth/verify-code', { email, code: await codeFor(email) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error('verify-code set no session cookie');
  return cookie.split(';')[0];
}

/** A CLI token through the device flow, approved by a browser session. */
async function deviceToken(email: string): Promise<string> {
  let approval: Promise<void> = Promise.resolve();
  const { token } = await kiteDeviceLogin({
    baseUrl: BASE!,
    label: 'agentio contract test',
    onCode: ({ userCode, verificationUrl }) => {
      expect(new URL(verificationUrl).origin).toBe(new URL(BASE!).origin);
      approval = (async () => {
        const cookie = await browserSession(email);
        const res = await post('/api/auth/device/approve', { userCode }, cookie);
        expect(res.status).toBe(200);
      })();
    },
  });
  await approval;
  return token;
}

run('contract with a real Kite', () => {
  const stamp = Date.now();
  const ME = `agentio-contract-${stamp}@example.com`;
  const OTHER = `agentio-contract-other-${stamp}@example.com`;

  test('one pass of every operation', async () => {
    const client = new KiteClient({ baseUrl: BASE!, token: await deviceToken(ME) });
    const other = new KiteClient({ baseUrl: BASE!, token: await deviceToken(OTHER) });

    expect(await client.validate()).toEqual({ valid: true, info: ME });

    // Publish, read, update, conflict.
    const described = { description: 'A contract check.', summary: 'Checks the fake against a real Kite.' };
    // A publish that says nothing about the document is refused by Kite itself, not only by this client.
    expect((await client.raw('POST', '/api/artifacts', { body: { type: 'markdown', content: '# x' } })).status).toBe(400);
    const doc = await client.publish({ type: 'markdown', content: '# Contract\n\nexact rendered text here', title: 'Contract', ...described });
    expect(Object.keys(doc).sort()).toEqual(
      ['description', 'id', 'summary', 'summaryVersion', 'title', 'type', 'updated', 'url', 'version'],
    );
    expect(doc).toMatchObject({ ...described, summaryVersion: 1 });
    expect(doc.id).toStartWith('art_');
    expect(doc.version).toBe(1);
    expect((await client.get(doc.id)).content).toBe('# Contract\n\nexact rendered text here');
    expect((await client.get(doc.url)).id).toBe(doc.id);
    const v2 = await client.update(doc.id, { type: 'markdown', content: '# Contract\n\nexact rendered text here, v2' });
    expect(v2).toMatchObject({ version: 2, ...described, summaryVersion: 1 });
    const stale = await client.raw('PUT', `/api/artifacts/${doc.id}`, { body: { type: 'markdown', content: 'x', baseVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(client.errorFor(stale).message).toContain('now version 2, you had 1');
    expect((await caught(client.publish({ type: 'markdown', content: '', ...described }))).code).toBe('INVALID_PARAMS');
    expect((await client.list()).map((d) => d.id)).toContain(doc.id);

    // Describing, workspaces, moving and organizing.
    const renamed = await client.describe(doc.id, { title: 'Contract, renamed', summary: 'Caught up.' });
    expect(renamed).toMatchObject({ title: 'Contract, renamed', version: 2, summary: 'Caught up.', summaryVersion: 2 });
    expect((await caught(client.describe(doc.id, { description: 'one\ntwo' }))).code).toBe('INVALID_PARAMS');
    expect((await caught(other.describe(doc.id, { title: 'Theirs now' }))).code).toBe('NOT_FOUND');
    const research = await client.createWorkspace('Contract research', 'Where the contract test sorts things.');
    expect(research).toMatchObject({ name: 'Contract research', count: 0 });
    expect((await caught(client.createWorkspace('contract RESEARCH', 'Again.'))).code).toBe('INVALID_PARAMS');
    expect((await client.move(doc.id, 'contract research')).workspace.id).toBe(research.id);
    const library = await client.organize();
    expect(library.workspaces.map((w) => w.id)).toEqual(['inbox', research.id]);
    expect(library.documents.find((d) => d.id === doc.id)).toMatchObject({ workspace: research.id, title: 'Contract, renamed' });
    expect((await client.move(doc.id, 'inbox')).workspace.id).toBe('inbox');

    // Someone else's document is not found, never forbidden.
    expect((await caught(other.get(doc.id))).code).toBe('NOT_FOUND');
    expect((await caught(other.update(doc.id, { type: 'markdown', content: 'x' }))).code).toBe('NOT_FOUND');
    expect((await caught(other.sharing(doc.id))).code).toBe('NOT_FOUND');

    // Sharing.
    expect(await client.sharing(doc.id)).toEqual({ id: doc.id, isPublic: false, people: [], domains: [], expiresAt: null });
    expect((await client.share(doc.id, OTHER)).notified).toBe(true);
    expect((await client.share(doc.id, OTHER)).notified).toBe(false);
    expect((await client.share(doc.id, 'example.org')).domains).toContain('example.org');
    expect((await caught(client.share(doc.id, 'gmail.com'))).code).toBe('INVALID_PARAMS');
    expect((await client.unshare(doc.id, 'example.org')).domains).not.toContain('example.org');
    expect((await caught(client.unshare(doc.id, 'nobody.example'))).code).toBe('NOT_FOUND');
    expect((await client.setPublic(doc.id, true)).isPublic).toBe(true);
    expect((await client.setPublic(doc.id, false)).isPublic).toBe(false);
    expect((await client.setExpiry(doc.id, '30d')).expiresAt).toBeString();
    expect((await client.setExpiry(doc.id, 'forever')).expiresAt).toBeNull();

    // Comments.
    const whole = await client.comment(doc.id, { body: 'On the whole thing' });
    expect(whole.mentions).toBeDefined();
    const passage = await client.comment(doc.id, { body: 'On a passage', snippet: 'exact rendered text here' });
    expect(passage.anchorLost).toBe(false);
    expect((await caught(client.comment(doc.id, { body: 'x', snippet: 'short' }))).code).toBe('INVALID_PARAMS');
    const reply = await other.reply(whole.id, 'A reply from someone it is shared with');
    expect(reply.author).toBe(OTHER);
    expect((await caught(other.setThreadStatus(whole.id, 'resolved'))).code).toBe('PERMISSION_DENIED');
    expect((await client.setThreadStatus(whole.id, 'resolved')).status).toBe('resolved');
    expect((await client.comments(doc.id, { status: 'resolved' })).map((t) => t.id)).toEqual([whole.id]);
    expect((await client.setThreadStatus(whole.id, 'open')).status).toBe('open');
    const threads = await client.comments(doc.id);
    expect(threads.map((t) => t.id).sort()).toEqual([whole.id, passage.id].sort());
    expect(threads[0]).toHaveProperty('anchorDrifted');
    const since = await client.comments(doc.id, { since: reply.createdAt });
    expect(since).toEqual([]);

    // Versions and views (Kite 1.3.0+): owner only, and a shared reader gets not found.
    const versions = await client.versions(doc.id);
    expect(versions.currentVersion).toBe(2);
    expect(versions.versions.map((v) => [v.version, v.kind, v.current])).toEqual([[2, 'edited', true], [1, 'published', false]]);
    expect(Object.keys(versions.versions[0]).sort()).toEqual(
      ['bytes', 'created', 'current', 'kind', 'otherViews', 'ownerViews', 'title', 'type', 'version', 'views'],
    );
    expect((await client.versions(doc.url)).id).toBe(doc.id);
    const first = await client.getVersion(doc.id, 1);
    expect(first).toMatchObject({ id: doc.id, version: 1, currentVersion: 2, current: false, content: '# Contract\n\nexact rendered text here' });
    expect((await caught(client.getVersion(doc.id, 9))).message).toContain('has no version 9');
    expect((await caught(client.getVersion(doc.id, 0))).code).toBe('INVALID_PARAMS');
    expect((await caught(other.versions(doc.id))).code).toBe('NOT_FOUND');
    expect((await caught(other.getVersion(doc.id, 1))).code).toBe('NOT_FOUND');
    const views = await client.views(doc.id);
    expect(views).toMatchObject({ id: doc.id, version: 2, views: 0 });
    expect(views.agentReads).toBeGreaterThan(0);
    expect(views.recent.some((e) => e.version === 1 && e.client === 'api')).toBe(true);
    expect((await client.viewsSummary()).documents.map((d) => d.id)).toContain(doc.id);
    expect((await caught(other.views(doc.id))).code).toBe('NOT_FOUND');

    // Delete, and a dead token.
    await client.delete(doc.id);
    expect((await caught(client.get(doc.id))).code).toBe('NOT_FOUND');
    const dead = new KiteClient({ baseUrl: BASE!, token: 'not-a-token' });
    expect((await caught(dead.list())).code).toBe('AUTH_EXPIRED');
  }, 120_000);

  test('canvases (Kite 1.4.0+), over HTTP', async () => {
    const client = new KiteClient({ baseUrl: BASE!, token: await deviceToken(`canvas-${ME}`) });
    const other = new KiteClient({ baseUrl: BASE!, token: await deviceToken(`canvas-${OTHER}`) });
    const canvas = new KiteCanvas(client);
    const board = JSON.stringify({
      nodes: [
        { id: 'g1', type: 'group', label: 'Plan', x: 0, y: 0, width: 700, height: 300 },
        { id: 'n1', type: 'text', text: 'Ship it', x: 40, y: 60, width: 260, height: 140 },
      ],
      edges: [],
    });
    const doc = await canvas.create({ content: board, title: 'Contract canvas', description: 'A contract check.', summary: 'Two nodes.' });
    expect(doc).toMatchObject({ type: 'canvas', version: 1 });

    const full = await canvas.get(doc.url);
    expect(full).toMatchObject({ id: doc.id, version: 1 });
    expect(full.nodes.map((n) => n.id)).toEqual(['g1', 'n1']);
    expect((await canvas.get(doc.id, { strict: true })).version).toBe(1);
    const outline = await canvas.outline(doc.id);
    expect(outline).toMatchObject({ id: doc.id, version: 1, counts: { nodes: 2, edges: 0, groups: 1 } });
    expect(outline.tree[0].children?.map((c) => c.id)).toEqual(['n1']);

    const dry = await canvas.ops(doc.id, [{ op: 'delete', id: 'n1' }], { baseVersion: 1, dryRun: true });
    expect(dry).toMatchObject({ version: 1, dryRun: true });
    const added = await canvas.ops(doc.id, [
      { op: 'add', tempId: 'q', near: 'n1', side: 'right', node: { type: 'text', text: 'Open question' } },
      { op: 'connect', from: 'n1', to: 'q', label: 'asks' },
    ], { baseVersion: 1 });
    expect(added.version).toBe(2);
    expect(Object.keys(added.ids)).toContain('q');

    const stale = await caught(canvas.ops(doc.id, [{ op: 'move', id: 'n1', x: 0, y: 0 }], { baseVersion: 1 }));
    expect(stale.message).toBe(`The canvas ${doc.id} changed since version 1: it is at version 2 now`);
    expect(stale.suggestion).toContain('--base-version 2');
    expect((await caught(canvas.ops(doc.id, [{ op: 'disconnect', id: 'nope' }], { baseVersion: 2 }))).code).toBe('INVALID_PARAMS');

    const readsBefore = (await client.views(doc.id)).agentReads;
    const first = await canvas.version(doc.id, 1);
    expect(first.nodes.map((n) => n.id)).toEqual(['g1', 'n1']);
    expect((await client.views(doc.id)).agentReads).toBe(readsBefore);

    const restored = await canvas.restore(doc.id, 1);
    expect(restored).toMatchObject({ version: 3, restoredFrom: 1 });
    expect((await canvas.get(doc.id)).nodes.map((n) => n.id)).toEqual(['g1', 'n1']);

    const markdown = await client.publish({ type: 'markdown', content: '# Not a canvas', description: 'D.', summary: 'S.' });
    expect((await caught(canvas.outline(markdown.id))).message).toContain('not a canvas');
    expect((await caught(new KiteCanvas(other).get(doc.id))).code).toBe('NOT_FOUND');
    expect((await caught(new KiteCanvas(other).ops(doc.id, [{ op: 'delete', id: 'n1' }], { baseVersion: 3 }))).code).toBe('NOT_FOUND');
    await client.delete(doc.id);
    await client.delete(markdown.id);
  }, 120_000);

  test('how a canvas looks: styles, icons, assets and the theme (Kite with canvas styles)', async () => {
    const client = new KiteClient({ baseUrl: BASE!, token: await deviceToken(`look-${ME}`) });
    const canvas = new KiteCanvas(client);
    const board = JSON.stringify({
      nodes: [
        { id: 'n1', type: 'text', text: 'A', x: 0, y: 0, width: 260, height: 140 },
        { id: 'n2', type: 'text', text: 'B', x: 400, y: 0, width: 260, height: 140 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    });
    const doc = await canvas.create({ content: board, title: 'Look', description: 'A contract check.', summary: 'Two nodes.' });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const done = await canvas.ops(doc.id, [
      { op: 'addAsset', tempId: 'icon', svg, name: 'logo' },
      { op: 'add', tempId: 'new', node: { type: 'text', text: 'Acme', kite: { icon: { name: 'asset:icon' } } } },
      { op: 'update', id: 'n1', set: { kite: { style: { fill: '#eef4ff', font: 'grotesk' }, icon: { name: 'lucide:server', position: 'top', size: 40 } } } },
      { op: 'update', id: 'e1', set: { color: '5', toEnd: 'arrow', kite: { style: { line: 'dashed', curve: 'step', width: 3 } } } },
      { op: 'theme', set: { background: '#f7f5ef', grid: 'dots', node: { radius: 12 }, edge: { color: '4' } } },
    ], { baseVersion: 1 });
    const asset = done.ids.icon!;
    const got = await canvas.get(doc.id);
    expect(got.kite?.theme).toEqual({ background: '#f7f5ef', grid: 'dots', node: { radius: 12 }, edge: { color: '4' } });
    expect(got.kite?.assets?.[asset]).toMatchObject({ type: 'svg', name: 'logo' });
    expect(got.nodes.find((n) => n.id === done.ids.new)!.kite).toMatchObject({ icon: { name: `asset:${asset}` } });
    expect(got.nodes.find((n) => n.id === 'n1')!.kite).toMatchObject({ style: { fill: '#eef4ff', font: 'grotesk' }, icon: { name: 'lucide:server', position: 'top', size: 40 } });
    expect(got.edges[0]).toMatchObject({ color: '5', toEnd: 'arrow', kite: { style: { line: 'dashed', curve: 'step', width: 3 } } });

    // Merged key by key, null going back to the default; the theme removed.
    await canvas.ops(doc.id, [
      { op: 'update', id: 'n1', set: { kite: { style: { fill: null, textColor: '#111111' }, icon: null } } },
      { op: 'theme', set: null },
    ], { baseVersion: done.version });
    const after = await canvas.get(doc.id);
    expect(after.nodes.find((n) => n.id === 'n1')!.kite).toMatchObject({ style: { font: 'grotesk', textColor: '#111111' } });
    expect((after.nodes.find((n) => n.id === 'n1')!.kite as Record<string, unknown>).icon).toBeUndefined();
    expect(after.kite?.theme).toBeUndefined();

    // What Kite refuses, the fake does not need to know: the message comes back.
    for (const ops of [
      [{ op: 'update', id: 'n1', set: { kite: { icon: { name: 'lucide:no-such-icon-anywhere' } } } }],
      [{ op: 'addAsset', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }],
      [{ op: 'update', id: 'n1', set: { kite: { style: { fill: 'red' } } } }],
    ]) {
      expect((await caught(canvas.ops(doc.id, ops, { baseVersion: done.version + 1 }))).code).toBe('INVALID_PARAMS');
    }
    const strict = await canvas.get(doc.id, { strict: true });
    expect(strict.kite).toBeUndefined();
    expect(strict.edges[0]).toEqual({ id: 'e1', fromNode: 'n1', toNode: 'n2', color: '5', toEnd: 'arrow' });
    await client.delete(doc.id);
  }, 120_000);

  test('a canvas as an image (Kite 1.6.0+)', async () => {
    const client = new KiteClient({ baseUrl: BASE!, token: await deviceToken(`image-${ME}`) });
    const other = new KiteClient({ baseUrl: BASE!, token: await deviceToken(`image-${OTHER}`) });
    const canvas = new KiteCanvas(client);
    const board = JSON.stringify({
      nodes: [
        { id: 'g1', type: 'group', label: 'Plan', x: 0, y: 0, width: 400, height: 220 },
        { id: 'n1', type: 'text', text: 'Ship it', x: 40, y: 60, width: 200, height: 100 },
      ],
      edges: [],
    });
    const doc = await canvas.create({ content: board, title: 'Plan / été', description: 'A contract check.', summary: 'Two nodes.' });

    const png = await canvas.image(doc.url);
    expect([...png.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png).toMatchObject({ id: doc.id, version: 1, format: 'png', name: 'Plan été.png', origin: { x: -32, y: -32 } });
    // The PNG's own size, from its header: 400 + 2·32 canvas pixels, at scale 2.
    const view = new DataView(png.bytes.buffer, png.bytes.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([928, 568]);

    const svg = await canvas.image(doc.id, { format: 'svg', node: 'n1', scale: 1, padding: 0, transparent: true });
    const text = new TextDecoder().decode(svg.bytes);
    expect(text).toStartWith('<svg');
    expect(text).toContain('>Ship it</text>');
    expect(svg).toMatchObject({ format: 'svg', name: 'Plan été.svg', origin: { x: 40, y: 60 } });

    await canvas.ops(doc.id, [{ op: 'delete', id: 'n1' }], { baseVersion: 1 });
    expect((await canvas.image(doc.id, { version: 1, format: 'svg' })).version).toBe(1);
    expect((await caught(canvas.image(doc.id, { node: 'n1' }))).message).toContain('no node "n1"');
    expect((await caught(canvas.image(doc.id, { scale: 4 }))).code).toBe('INVALID_PARAMS');
    expect((await caught(new KiteCanvas(other).image(doc.id))).code).toBe('NOT_FOUND');
    await client.delete(doc.id);
  }, 120_000);
});
