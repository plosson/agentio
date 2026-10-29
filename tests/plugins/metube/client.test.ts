import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MetubeClient, parseServerUrl } from '../../../src/plugins/metube/client';
import { addRequest, fetchDownloads, queueLinks, resolveId, timing, waitFor } from '../../../src/plugins/metube/commands';
import { CliError } from '../../../src/utils/errors';
import { FakeMetube } from './fake-metube';

let server: FakeMetube;
let dir: string;
timing.pollMs = 1;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentio-metube-'));
});
afterEach(() => server?.stop());

async function caught(p: Promise<unknown>): Promise<CliError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(CliError); return e as CliError; }
  throw new Error('expected a CliError');
}

test('parseServerUrl keeps the path, drops the trailing slash, refuses credentials', () => {
  expect(parseServerUrl(' https://metube.example.com/ ')).toBe('https://metube.example.com');
  expect(parseServerUrl('https://example.com/metube/')).toBe('https://example.com/metube');
  expect(() => parseServerUrl('https://u:p@example.com')).toThrow(CliError);
  expect(() => parseServerUrl('ftp://example.com')).toThrow(CliError);
});

test('addRequest maps the options onto /add', () => {
  expect(addRequest('u', {})).toEqual({ url: 'u', download_type: 'video', format: 'any', quality: 'best', auto_start: true });
  expect(addRequest('u', { audio: true })).toMatchObject({ download_type: 'audio', format: 'mp3' });
  expect(addRequest('u', { quality: '720', format: 'mp4', folder: ' clips ' })).toMatchObject({ quality: '720', format: 'mp4', folder: 'clips' });
  expect(() => addRequest('u', { folder: ' ' })).toThrow(CliError);
});

test('get end to end: queue, wait, save, then remove from the server', async () => {
  server = new FakeMetube({ auth: { username: 'me', password: 's3cret' } });
  const client = new MetubeClient({ url: server.url, username: 'me', password: 's3cret' });
  const keys = await queueLinks(client, ['https://www.youtube.com/watch?v=abc'], {});
  expect(keys).toEqual(['https://www.youtube.com/watch?v=abc']);
  const lines: string[] = [];
  const results = await waitFor(client, keys, (l) => lines.push(l));
  expect(lines).toContain('Video abc: finished');
  const saved = await fetchDownloads(client, results.map((r) => r.d), dir, false);
  expect(saved[0].path).toBe(join(dir, 'Video abc.mp4'));
  expect(readFileSync(saved[0].path!, 'utf8')).toBe('bytes of Video abc');
  expect(server.done.size).toBe(0);
  expect(server.files.size).toBe(0);
  expect(server.requests.every((r) => r.authorization === `Basic ${btoa('me:s3cret')}`)).toBe(true);
});

test('--keep leaves the download and its file on the server, and a taken name is not overwritten', async () => {
  server = new FakeMetube();
  const client = new MetubeClient({ url: server.url });
  writeFileSync(join(dir, 'Video abc.mp3'), 'older');
  const keys = await queueLinks(client, ['https://youtu.be/abc'], { audio: true });
  const results = await waitFor(client, keys, () => {});
  const saved = await fetchDownloads(client, results.map((r) => r.d), dir, true);
  expect(saved[0].path).toBe(join(dir, 'Video abc (1).mp3'));
  expect(readFileSync(join(dir, 'Video abc.mp3'), 'utf8')).toBe('older');
  expect(server.done.size).toBe(1);
  expect(server.requests.some((r) => r.path === '/audio_download/Video abc.mp3')).toBe(true);
});

test('a playlist link yields every video it queued, and a link queued again is found under its old key', async () => {
  server = new FakeMetube({ playlists: { 'https://yt/list': ['https://yt/v=1', 'https://yt/v=2'] } });
  const client = new MetubeClient({ url: server.url });
  expect(await queueLinks(client, ['https://yt/list'], {})).toEqual(['https://yt/v=1', 'https://yt/v=2']);
  await waitFor(client, ['https://yt/v=1', 'https://yt/v=2'], () => {});
  expect(await queueLinks(client, ['https://yt/v=1'], {})).toEqual(['https://yt/v=1']);
});

test('a failed download comes back failed with its error', async () => {
  server = new FakeMetube({ failing: { 'https://yt/v=x': 'Sign in to confirm you are not a bot' } });
  const client = new MetubeClient({ url: server.url });
  const [r] = await waitFor(client, await queueLinks(client, ['https://yt/v=x'], {}), () => {});
  expect(r.d.status).toBe('error');
  expect(r.d.error).toContain('not a bot');
});

test('wrong credentials and refused options are clear errors', async () => {
  server = new FakeMetube({ auth: { username: 'me', password: 'right' } });
  const bad = await caught(new MetubeClient({ url: server.url, username: 'me', password: 'wrong' }).history());
  expect(bad.code).toBe('AUTH_FAILED');
  expect(bad.message).not.toContain('wrong');
  const client = new MetubeClient({ url: server.url, username: 'me', password: 'right' });
  const refused = await caught(queueLinks(client, ['https://yt/v=1'], { quality: 'nope' }));
  expect(refused.code).toBe('INVALID_PARAMS');
  expect(refused.message).toContain("quality 'nope'");
});

test('resolveId takes the key or the video id, and refuses an ambiguous id', async () => {
  const d = (url: string, id: string) => ({ id, url, title: id, status: 'finished', download_type: 'video', timestamp: 1 });
  const history = { queue: [], pending: [], done: [d('https://a/1', 'x'), d('https://b/1', 'x'), d('https://c/2', 'y')] };
  expect(resolveId(history, 'https://b/1').d.url).toBe('https://b/1');
  expect(resolveId(history, 'y').d.url).toBe('https://c/2');
  expect(() => resolveId(history, 'x')).toThrow('Several downloads');
  expect(() => resolveId(history, 'z')).toThrow('No download');
});

test('an unreachable server is a network error', async () => {
  server = new FakeMetube();
  const url = server.url;
  server.stop();
  expect((await caught(new MetubeClient({ url }).version())).code).toBe('NETWORK_ERROR');
  expect(readdirSync(dir)).toEqual([]);
});
