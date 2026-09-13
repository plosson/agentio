import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import { createRequestHandler } from '../daemon/api';
import { approveDeviceAuth, denyDeviceAuth, resetDeviceAuth } from '../daemon/device-auth';
import { deviceLimiter } from '../daemon/routes-v1';
import { deviceLogin, hubOrigin } from './device-login';
import { isRemoteMode, resetRemoteCache } from './remote';

/**
 * The CLI half talks to a real Bun.serve running the hub handler in this
 * process, so the owner's approval is a direct call into the store.
 */

withTempVault('agentio-login-test-', () => ({ config: { profiles: { slack: [{ name: 'ops' }] } } }));

let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  const handle = createRequestHandler({ version: 'test' });
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req, srv) => handle(req, srv) });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  delete process.env.AGENTIO_TOKEN;
  resetRemoteCache();
  resetDeviceAuth();
  deviceLimiter.reset();
});

describe('device login', () => {
  test('hub URL is normalised to an origin', () => {
    expect(hubOrigin('vault.example.com')).toBe('https://vault.example.com');
    expect(hubOrigin('https://vault.example.com/ui/')).toBe('https://vault.example.com');
    expect(hubOrigin('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(() => hubOrigin('ftp://x')).toThrow('http');
    expect(() => hubOrigin('not a url')).toThrow('hub URL');
  });

  test('polls until the owner approves, then returns the token and key', async () => {
    let shown: { userCode: string; verifyUrl: string } | null = null;
    const login = deviceLogin({
      url: `${url}/ui`,
      name: 'test-box',
      pollMs: 20,
      onCode: (info) => {
        shown = info;
        // The owner approves a moment later, with a narrower scope than asked.
        setTimeout(() => approveDeviceAuth(info.userCode, { name: 'renamed', allowedProfiles: ['slack/ops'], readOnly: true }, url), 60);
      },
    });
    const result = await login;
    expect(shown!.verifyUrl).toBe(`${url}/ui#authorize=${shown!.userCode}`);
    expect(result.url).toBe(url);
    expect(result.token).toMatch(/^agio1\./);
    expect(result.key).toMatchObject({ name: 'renamed', allowedProfiles: ['slack/ops'], readOnly: true });
    expect(isRemoteMode()).toBe(false); // the command stores it; the flow itself does not
  });

  test('a denied request fails with AUTH_FAILED', async () => {
    const login = deviceLogin({
      url,
      pollMs: 20,
      onCode: ({ userCode }) => setTimeout(() => denyDeviceAuth(userCode), 40),
    });
    await expect(login).rejects.toMatchObject({ code: 'AUTH_FAILED', message: expect.stringContaining('denied') });
  });

  test('a hub without the route is explained, an unreachable one is a network error', async () => {
    const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('nope', { status: 404 }) });
    const landing = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    try {
      await expect(deviceLogin({ url: `http://127.0.0.1:${plain.port}`, onCode: () => {} })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
      await expect(deviceLogin({ url: `http://127.0.0.1:${landing.port}`, onCode: () => {} })).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    } finally {
      plain.stop(true);
      landing.stop(true);
    }
    await expect(deviceLogin({ url: 'http://127.0.0.1:1', onCode: () => {} })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
