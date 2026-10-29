import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { argValue, buildBody, parseArgs, uploadLocalFiles } from '../../../src/plugins/higgsfield/body';
import { HiggsfieldApiError, HiggsfieldClient, parseKey, parseModelId } from '../../../src/plugins/higgsfield/client';
import { describeKey, higgsfieldProfileAdd } from '../../../src/plugins/higgsfield/commands';
import { destinations, failureOf, outputUrls, readRecords, saveOutputs, saveRecord, submit, timing, waitFor } from '../../../src/plugins/higgsfield/requests';
import { CliError } from '../../../src/utils/errors';
import { fakeSetupContext } from '../../helpers/setup-context';
import { FakeHiggsfield } from './fake-higgsfield';

Object.assign(timing, { pollStartMs: 0, pollMaxMs: 0, jitterMs: 0, submitBackoffMs: [0, 0, 0] });

let server: FakeHiggsfield;
let dir: string;
const previousHome = process.env.AGENTIO_HOME;
const home = mkdtempSync(join(tmpdir(), 'agentio-hf-home-'));
beforeAll(() => { process.env.AGENTIO_HOME = home; });
afterAll(() => {
  if (previousHome === undefined) delete process.env.AGENTIO_HOME; else process.env.AGENTIO_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentio-hf-')); });
afterEach(() => { server?.stop(); rmSync(dir, { recursive: true, force: true }); });

const client = () => new HiggsfieldClient({ key: 'kid:ksecret' }, server.url);
const quiet = () => {};

async function caught(p: Promise<unknown>): Promise<CliError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(CliError); return e as CliError; }
  throw new Error('expected a CliError');
}

test('parseKey and parseModelId', () => {
  expect(parseKey(' id:secret ')).toBe('id:secret');
  expect(() => parseKey('nocolon')).toThrow(CliError);
  expect(parseModelId('/higgsfield-ai/soul/v2/standard/')).toBe('higgsfield-ai/soul/v2/standard');
  expect(() => parseModelId('soul')).toThrow(CliError);
  expect(() => parseModelId('a/../b?x')).toThrow(CliError);
  expect(describeKey({ key: '0123456789abcdef:topsecret' })).toBe('01234567…');
});

test('--arg values are typed, repeated keys and key[] make arrays, args replace json-body keys', () => {
  expect([argValue('true'), argValue('false'), argValue('null'), argValue('5'), argValue('-1.5'), argValue('720p'), argValue('007')]).toEqual([true, false, null, 5, -1.5, '720p', '007']);
  expect(argValue('["a",1]')).toEqual(['a', 1]);
  expect(() => argValue('{bad')).toThrow(CliError);
  expect(parseArgs(['prompt=a=b', 'image_urls=x', 'image_urls=y', 'one[]=z'])).toEqual({ prompt: 'a=b', image_urls: ['x', 'y'], one: ['z'] });
  expect(() => parseArgs(['novalue'])).toThrow(CliError);
  const file = join(dir, 'body.json');
  writeFileSync(file, JSON.stringify({ prompt: 'old', resolution: '480p' }));
  expect(buildBody({ jsonBody: file, arg: ['prompt=new'] })).toEqual({ prompt: 'new', resolution: '480p' });
  writeFileSync(file, '[1]');
  expect(() => buildBody({ jsonBody: file })).toThrow('must be a JSON object');
});

test('local media files are uploaded once, at any depth; URLs and prompts are left alone', async () => {
  writeFileSync(join(dir, 'face.jpg'), 'jpg');
  const calls: string[] = [];
  const { body } = await uploadLocalFiles(
    { prompt: 'a cat.jpg-like idea', image_urls: [join(dir, 'face.jpg'), 'https://x/y.jpg'], nested: { ref: join(dir, 'face.jpg') }, n: 3 },
    async (path, type) => { calls.push(`${path} ${type}`); return 'https://cdn/face'; },
  );
  expect(body).toEqual({ prompt: 'a cat.jpg-like idea', image_urls: ['https://cdn/face', 'https://x/y.jpg'], nested: { ref: 'https://cdn/face' }, n: 3 });
  expect(calls).toEqual([`${join(dir, 'face.jpg')} image/jpeg`]);
  await expect(uploadLocalFiles({ video_url: join(dir, 'missing.mp4') }, async () => 'u')).rejects.toThrow('No such file');
});

test('upload goes through the presigned URL with its headers and never sends the key there', async () => {
  server = new FakeHiggsfield();
  const url = await client().upload(new Blob(['bytes']), 'image/png');
  expect(url).toStartWith(`${server.url}/cdn/input/`);
  const put = server.log.find((r) => r.method === 'PUT')!;
  expect(put.headers.authorization).toBeUndefined();
  expect(put.headers['content-type']).toBe('image/png');
  expect(new TextDecoder().decode([...server.stored.values()][0])).toBe('bytes');
});

test('run end to end: submit with an Idempotency-Key, wait, save every output', async () => {
  server = new FakeHiggsfield();
  const c = client();
  const accepted = await submit(c, 'higgsfield-ai/soul/v2/standard', { prompt: 'p' }, 'idem-1', quiet);
  const lines: string[] = [];
  const status = await waitFor(c, accepted.request_id, (l) => lines.push(l));
  expect(status.status).toBe('completed');
  expect(lines).toEqual([`${accepted.request_id}: queued`, `${accepted.request_id}: completed`]);
  const paths = await saveOutputs(c, status, `${dir}/`);
  expect(paths).toEqual([join(dir, `${accepted.request_id}-1.png`), join(dir, `${accepted.request_id}-2.png`)]);
  expect(readFileSync(paths[0], 'utf8')).toBe('output /cdn/out/a.png');
  const submitted = server.log.find((r) => r.path === '/higgsfield-ai/soul/v2/standard')!;
  expect(submitted.headers['idempotency-key']).toBe('idem-1');
  expect(submitted.headers.authorization).toBe('Key kid:ksecret');
  expect(server.log.filter((r) => r.path.startsWith('/cdn/')).every((r) => !r.headers.authorization)).toBe(true);
  await expect(saveOutputs(c, status, `${dir}/`)).rejects.toThrow('already exists');
});

test('a full queue (429) is retried with the same Idempotency-Key and creates one request', async () => {
  server = new FakeHiggsfield({ queueFullTimes: 2 });
  const lines: string[] = [];
  const accepted = await submit(client(), 'm/x', { prompt: 'p' }, 'same-key', (l) => lines.push(l));
  const posts = server.log.filter((r) => r.path === '/m/x');
  expect(posts.map((r) => r.headers['idempotency-key'])).toEqual(['same-key', 'same-key', 'same-key']);
  expect(server.requests.size).toBe(1);
  expect(accepted.request_id).toBe([...server.requests.keys()][0]);
  expect(lines[0]).toContain('Too many queued generations');
});

test('a 429 that outlasts every retry, a 422 and a 401 are clear errors', async () => {
  server = new FakeHiggsfield({ queueFullTimes: 10 });
  const full = await caught(submit(client(), 'm/x', {}, 'k', quiet));
  expect(full.code).toBe('RATE_LIMITED');
  server.stop();
  server = new FakeHiggsfield();
  const invalid = await caught(submit(client(), 'm/x', { prompt: '' }, 'k', quiet));
  expect(invalid.code).toBe('INVALID_PARAMS');
  expect(invalid.message).toContain('prompt: String should have at least 1 character');
  const auth = await caught(new HiggsfieldClient({ key: 'kid:wrong' }, server.url).status('x'));
  expect(auth.code).toBe('AUTH_FAILED');
  expect(auth.message).not.toContain('wrong');
});

test('failed, nsfw and canceled requests are errors with what Higgsfield said', async () => {
  for (const [status, text] of [['failed', 'failed: Generation failed'], ['nsfw', 'content moderation'], ['canceled', 'was canceled']] as const) {
    server = new FakeHiggsfield({ outcome: { status, error: status === 'failed' ? 'Generation failed' : undefined } });
    const { request_id } = await submit(client(), 'm/x', {}, 'k', quiet);
    const final = await waitFor(client(), request_id, quiet);
    expect(final.status).toBe(status);
    expect(failureOf(final)!.message).toContain(text);
    server.stop();
  }
});

test('cancel works while queued, delete refuses a running request, estimate shows usd or pricing text', async () => {
  server = new FakeHiggsfield();
  const c = client();
  const { request_id } = await submit(c, 'm/x', {}, 'k', quiet);
  expect((await caught(c.delete(request_id))).message).toContain('cannot delete');
  await c.cancel(request_id);
  expect((await c.status(request_id)).status).toBe('canceled');
  await c.delete(request_id);
  expect((await caught(c.status(request_id))).code).toBe('NOT_FOUND');
  expect(await c.estimate('higgsfield-ai/soul/v2/standard', { prompt: 'p' })).toEqual({ usd: '0.094' });
  expect((await c.estimate('higgsfield/genjutsu/motion-transfer/v1.0', {})).pricing_description).toContain('$0.318');
});

test('outputUrls reads images, video, audio and audios once each; destinations follow -o', () => {
  const s = { request_id: 'r', status: 'completed' as const, video: { url: 'https://c/v.mp4' }, audio: { url: 'https://c/a.mp3' }, audios: [{ url: 'https://c/a.mp3' }], zip: { url: 'https://c/z.zip' }, status_url: 'https://api/s' };
  expect(outputUrls(s)).toEqual(['https://c/v.mp4', 'https://c/a.mp3', 'https://c/z.zip']);
  expect(destinations(['https://c/v.mp4'], 'r', join(dir, 'out.mp4'))).toEqual([join(dir, 'out.mp4')]);
  expect(destinations(['https://c/1.png', 'https://c/2.png'], 'r', join(dir, 'pic.png'))).toEqual([join(dir, 'pic-1.png'), join(dir, 'pic-2.png')]);
  mkdirSync(join(dir, 'sub'));
  expect(destinations(['https://c/v.mp4'], 'r', join(dir, 'sub'))).toEqual([join(dir, 'sub', 'r.mp4')]);
});

test('the local request list lives under the agentio home, newest first, updated in place', async () => {
  await saveRecord('p1', { requestId: 'a', model: 'm/x', createdAt: '2026-10-29T10:00:00Z', status: 'queued' });
  await saveRecord('p1', { requestId: 'b', model: 'm/y', createdAt: '2026-10-29T11:00:00Z', status: 'queued' });
  await saveRecord('p1', { requestId: 'a', status: 'completed', outputs: ['/tmp/a.png'] });
  await saveRecord('p1', { requestId: 'unknown', status: 'completed' });
  expect((await readRecords('p1')).map((r) => [r.requestId, r.status])).toEqual([['b', 'queued'], ['a', 'completed']]);
  expect(await readRecords('p2')).toEqual([]);
  expect(existsSync(join(home, 'cache', 'higgsfield'))).toBe(true);
});

test('profile setup asks for the key as a secret and checks it with a free status lookup', async () => {
  server = new FakeHiggsfield();
  const context = fakeSetupContext({ 'API key': 'kid:ksecret' });
  const result = await higgsfieldProfileAdd({}, context, server.url);
  expect(result.credentials).toEqual({ key: 'kid:ksecret' });
  expect(context.asked.map((s) => s.kind)).toEqual(['secret']);
  expect(result.info).not.toContain('ksecret');
  expect(server.log.map((r) => r.path)).toEqual(['/requests/00000000-0000-0000-0000-000000000000/status']);
  const bad = await caught(higgsfieldProfileAdd({ key: 'kid:wrong' }, fakeSetupContext({}), server.url));
  expect(bad).toBeInstanceOf(HiggsfieldApiError);
  expect(bad.code).toBe('AUTH_FAILED');
});
