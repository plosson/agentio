import { afterEach, expect, test } from 'bun:test';
import { capturePicsiSignIn, findPicsiBrowser, parsePicsiCallback } from '../../../src/plugins/picsi/browser';

const TOKEN = 'picsi-browser-test-secret';
const available = !!(await findPicsiBrowser());
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

// The detached callback and immediate close are exactly the pattern in Picsi's /user/callback.
const callback = (response: unknown) => `<script>(function () {var callback = window.opener || window.uxpHost || undefined;callback = callback ? callback.postMessage : console.log;callback(${JSON.stringify(JSON.stringify(response))}, '*');window.close();})();</script>`;

function provider(response: unknown, contentType = 'text/html'): { origin: string; requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === '/user/login') return new Response(null, { status: 302, headers: { location: '/user/callback?code=fake-oauth-code' } });
      if (path === '/user/callback') return new Response(callback(response), { headers: { 'content-type': contentType } });
      return new Response('Not found', { status: 404 });
    },
  });
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.port}`, requests };
}

test('the Picsi callback is parsed as data, without executing its script or echoing its secrets', () => {
  expect(parsePicsiCallback(callback({ code: 0, data: { token: TOKEN } }))).toBe(TOKEN);
  expect(parsePicsiCallback(JSON.stringify({ code: 0, data: { token: TOKEN } }))).toBe(TOKEN);
  for (const body of [callback({ code: 601001, data: { token: TOKEN } }), callback({ code: 0, data: {} }), '<script>throw new Error()</script>', 'not-json', 'null']) {
    try { parsePicsiCallback(body); throw new Error('expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'AUTH_FAILED' });
      expect(String(error)).not.toContain(TOKEN);
    }
  }
});

test.skipIf(!available)('a real browser captures the session before Picsi closes its callback window', async () => {
  const api = provider({ code: 0, data: { token: TOKEN } });
  const result = await capturePicsiSignIn({ origin: api.origin, headless: true, timeoutMs: 15_000 });
  expect(result).toBe(TOKEN);
  expect(api.requests.filter((path) => path === '/user/login')).toHaveLength(1);
  expect(api.requests.filter((path) => path === '/user/callback')).toHaveLength(1);
}, 20_000);

test.skipIf(!available)('the real browser accepts the callback served as plain text, as Picsi currently serves it', async () => {
  const api = provider({ code: 0, data: { token: TOKEN } }, 'text/plain;charset=UTF-8');
  expect(await capturePicsiSignIn({ origin: api.origin, headless: true, timeoutMs: 15_000 })).toBe(TOKEN);
}, 20_000);

test.skipIf(!available)('refused browser sign-in is an error and never leaks the response body', async () => {
  const api = provider({ code: 601001, data: { token: TOKEN } });
  try { await capturePicsiSignIn({ origin: api.origin, headless: true, timeoutMs: 15_000 }); throw new Error('expected rejection'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'AUTH_FAILED' });
    expect(String(error)).not.toContain(TOKEN);
  }
}, 20_000);

test.skipIf(!available)('closing the real sign-in window ends setup without waiting for the timeout', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<p>Sign in</p>', { headers: { 'content-type': 'text/html' } }) });
  servers.push(server);
  try { await capturePicsiSignIn({ origin: `http://127.0.0.1:${server.port}`, headless: true, timeoutMs: 15_000, onReady: (window) => window.close() }); throw new Error('expected cancellation'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'AUTH_FAILED' });
    expect(String(error)).toContain('closed');
  }
}, 20_000);

test.skipIf(!available)('a callback on a different origin is not accepted as a Picsi session', async () => {
  const other = provider({ code: 0, data: { token: TOKEN } }, 'text/plain');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 302, headers: { location: other.origin + '/user/callback' } }) });
  servers.push(server);
  try { await capturePicsiSignIn({ origin: `http://127.0.0.1:${server.port}`, headless: true, timeoutMs: 1200 }); throw new Error('expected timeout'); }
  catch (error) {
    expect(error).toMatchObject({ code: 'AUTH_FAILED' });
    expect(String(error)).toContain('timed out');
    expect(String(error)).not.toContain(TOKEN);
  }
}, 20_000);
