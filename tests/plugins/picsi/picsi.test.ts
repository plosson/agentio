import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PicsiClient } from '../../../src/plugins/picsi/client';
import { picsiProfileAdd } from '../../../src/plugins/picsi/commands';
import { checkDestination, readImage, saveImage } from '../../../src/plugins/picsi/files';
import { swapSettings } from '../../../src/plugins/picsi/settings';
import { fakeSetupContext } from '../../helpers/setup-context';

const TOKEN = 'picsi-session-secret';
const JOB_TOKEN = 'picsi-job-secret';
const USER = { uid: '123', name: 'Pat', email: 'pat@example.com', role: 'Pro', creditsAll: '400', creditsRemain: '398', token: TOKEN };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const quiet = () => {};
const servers: Array<{ stop: (close?: boolean) => unknown }> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function api(handle: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentio-picsi-'));
  dirs.push(dir);
  return dir;
}

test('account lookup sends the Picsi session header and exposes only public account fields', async () => {
  const url = api((request) => {
    expect(new URL(request.url).pathname).toBe('/user/info');
    expect(request.method).toBe('GET');
    expect(request.headers.get('uk')).toBe(TOKEN);
    return Response.json({ code: 0, data: USER });
  });
  const client = new PicsiClient({ token: TOKEN }, { baseUrl: url });
  expect(await client.account()).toEqual({ id: '123', name: 'Pat', email: 'pat@example.com', plan: 'Pro', creditsRemaining: 398, creditsTotal: 400 });
  expect(JSON.stringify(await client.validate())).not.toContain(TOKEN);
});

test('an anonymous success response, expired session and echoed token are handled without leaking credentials', async () => {
  const anonymous = api(() => Response.json({ code: 0, data: {} }));
  await expect(new PicsiClient({ token: TOKEN }, { baseUrl: anonymous }).account()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  const expired = api(() => Response.json({ code: 90401, message: `Invalid ${TOKEN}` }));
  const result = await new PicsiClient({ token: TOKEN }, { baseUrl: expired }).validate();
  expect(result.valid).toBe(false);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

test('token import uses a hidden question and validates without creating a swap', async () => {
  const calls: string[] = [];
  const context = fakeSetupContext({ 'Picsi session token': TOKEN });
  context.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    expect(new Headers(init?.headers).get('uk')).toBe(TOKEN);
    return Response.json({ code: 0, data: USER });
  }) as typeof fetch;
  const result = await picsiProfileAdd({ token: true }, context);
  expect(result.credentials).toEqual({ token: TOKEN, name: 'Pat', email: 'pat@example.com' });
  expect(context.asked.map((spec) => spec.kind)).toEqual(['secret']);
  expect(calls).toEqual(['https://www.picsi.ai/user/info']);
  expect(result.info).not.toContain(TOKEN);
  await expect(picsiProfileAdd({ token: 'bad\nheader' }, context)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(calls).toHaveLength(1);
});

test('browser setup checks the returned session before storing it', async () => {
  const context = fakeSetupContext({});
  context.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ code: 0, data: USER })) as typeof fetch;
  const result = await picsiProfileAdd({}, context, async (provided) => {
    expect(provided).toBe(context);
    return TOKEN;
  });
  expect(result.credentials.token).toBe(TOKEN);
  expect(context.asked).toHaveLength(0);
});

test('--no-browser asks for a Picsi session as a secret and never starts a browser', async () => {
  const context = fakeSetupContext({ 'Picsi session token': TOKEN });
  context.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ code: 0, data: USER })) as typeof fetch;
  const result = await picsiProfileAdd({ browser: false }, context, async () => { throw new Error('must not open a browser'); });
  expect(result.credentials.token).toBe(TOKEN);
  expect(context.asked.map((spec) => spec.kind)).toEqual(['secret']);
});

test('one swap waits for a job token, uploads both images and options once, and downloads without the session header', async () => {
  let polls = 0;
  let swaps = 0;
  let start: number | undefined;
  const url = api(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/output.png') {
      expect(request.headers.get('uk')).toBeNull();
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    expect(request.headers.get('uk')).toBe(TOKEN);
    if (path === '/api/morph/token') {
      const body = await request.json() as { count: number; time: number };
      expect(body.count).toBe(++polls);
      start ??= body.time;
      expect(body.time).toBe(start);
      return Response.json(polls === 1 ? { code: 9031 } : { code: 0, data: { token: JOB_TOKEN, count: polls, time: start } });
    }
    expect(path).toBe('/api/morph/image');
    swaps++;
    const form = await request.formData();
    expect(form.get('token')).toBe(JOB_TOKEN);
    expect(form.get('active')).toBe('1');
    expect(form.get('apisource')).toBe('8');
    expect([form.get('cx'), form.get('cy')]).toEqual(['2500', '7500']);
    expect([form.get('dax'), form.get('opt'), form.get('m'), form.get('shapify'), form.get('shapifyVal')]).toEqual(['true', 'true', 'true', 'true', '700']);
    expect(form.get('d_ts')).toBe(String(start));
    expect(form.get('d_tc')).toBe('2');
    expect(Buffer.from(await (form.get('source_0') as File).arrayBuffer())).toEqual(PNG);
    expect(Buffer.from(await (form.get('target') as File).arrayBuffer())).toEqual(PNG);
    return Response.json({ code: 0, data: { output: url + '/output.png', userInfo: USER } });
  });
  const client = new PicsiClient({ token: TOKEN }, { baseUrl: url, pollMs: 0 });
  const dir = await directory();
  const input = join(dir, 'face.png');
  await writeFile(input, PNG);
  const image = await readImage(input);
  const result = await client.swap(image, image, swapSettings({ at: '25,75', retainMouth: true, shapify: '700' }), quiet);
  expect(result.creditsRemaining).toBe(398);
  const output = join(dir, 'result.png');
  await saveImage(result.output, output);
  expect(await readFile(output)).toEqual(PNG);
  expect([polls, swaps]).toEqual([2, 1]);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
});

test('a refused image submission is never retried and never echoes either token', async () => {
  let calls = 0;
  const url = api((request) => {
    if (new URL(request.url).pathname.endsWith('/token')) return Response.json({ code: 0, data: { token: JOB_TOKEN, time: 1, count: 1 } });
    calls++;
    return Response.json({ code: 500, message: `Failed ${TOKEN} ${JOB_TOKEN}` }, { status: 503 });
  });
  const client = new PicsiClient({ token: TOKEN }, { baseUrl: url });
  const image = { blob: new Blob([PNG], { type: 'image/png' }), name: 'face.png' };
  try { await client.swap(image, image, swapSettings({}), quiet); throw new Error('expected refusal'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'API_ERROR' });
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(JOB_TOKEN);
  }
  expect(calls).toBe(1);
});

test('a busy queue times out without submitting an image, and authenticated requests never follow redirects', async () => {
  const paths: string[] = [];
  const busy = api((request) => {
    paths.push(new URL(request.url).pathname);
    return Response.json({ code: 9031 });
  });
  const image = { blob: new Blob([PNG], { type: 'image/png' }), name: 'face.png' };
  await expect(new PicsiClient({ token: TOKEN }, { baseUrl: busy, pollMs: 1, waitMs: 5 }).swap(image, image, swapSettings({}), quiet)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path === '/api/morph/token')).toBe(true);
  const redirected: string[] = [];
  const url = api((request) => {
    redirected.push(new URL(request.url).pathname);
    return new Response(null, { status: 302, headers: { location: '/other' } });
  });
  await expect(new PicsiClient({ token: TOKEN }, { baseUrl: url }).account()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  expect(redirected).toEqual(['/user/info']);
});

test('invalid coordinates, non-image inputs and occupied output paths fail before submission', async () => {
  for (const at of ['bad', '1', '1,2,3', '-1,50', '101,50', ',50']) expect(() => swapSettings({ at })).toThrow();
  for (const shapify of ['', '0', '1001', '1.5']) expect(() => swapSettings({ shapify })).toThrow();
  const dir = await directory();
  const output = join(dir, 'existing.png');
  await writeFile(output, PNG);
  await expect(checkDestination(output)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(readImage(join(dir, 'missing.png'))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await writeFile(join(dir, 'face.gif'), 'GIF89a');
  await expect(readImage(join(dir, 'face.gif'))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(saveImage(`data:image/png;base64,${PNG.toString('base64')}`, output)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(await readFile(output)).toEqual(PNG);
});
