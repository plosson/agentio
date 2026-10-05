import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { createRequestHandler } from '../../src/daemon/api';
import { approveDeviceAuth, denyDeviceAuth, describeDeviceAuth, resetDeviceAuth } from '../../src/daemon/device-auth';
import { deviceLimiter } from '../../src/daemon/routes-v1';
import { deviceLogin, hubOrigin, replacementToken } from '../../src/auth/device-login';
import { authenticateToken } from '../../src/auth/api-keys';
import { encodeToken } from '../../src/auth/token';
import { isRemoteMode, resetRemoteCache } from '../../src/auth/remote';

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

  test('a stored token is only ever offered to the hub it belongs to', () => {
    const mine = encodeToken({ url: 'https://vault.example.com', kid: 'k1', secret: 's'.repeat(43) });
    expect(replacementToken(mine, 'https://vault.example.com')).toBe(mine);
    expect(replacementToken(mine, 'https://other.example.com')).toBeUndefined();
    expect(replacementToken(mine, 'https://vault.example.com:8443')).toBeUndefined();
    expect(replacementToken(encodeToken({ url: 'https://vault.example.com/ui/', kid: 'k1', secret: 's' }), 'https://vault.example.com')).toBeDefined();
    for (const bad of [null, undefined, '', 'garbage']) expect(replacementToken(bad, 'https://vault.example.com')).toBeUndefined();
  });

  test('scopes are granted exactly, and a second login replaces the first key', async () => {
    const approveWhenShown = (onRequest?: (view: Awaited<ReturnType<typeof describeDeviceAuth>>) => void) =>
      (info: { userCode: string }) => setTimeout(async () => {
        onRequest?.(await describeDeviceAuth(info.userCode));
        await approveDeviceAuth(info.userCode, { name: 'ignored', allowedProfiles: ['slack/ops'], readOnly: true }, url);
      }, 40);

    const first = await deviceLogin({ url, pollMs: 20, name: 'first-name', scopes: ['profiles:write', 'profiles:manage'], onCode: approveWhenShown() });
    expect(first.key).toMatchObject({ allowedProfiles: '*', readOnly: false, canManageProfiles: true });

    let seen: Awaited<ReturnType<typeof describeDeviceAuth>> | null = null;
    const second = await deviceLogin({ url, pollMs: 20, scopes: ['profiles:read'], currentToken: first.token, onCode: approveWhenShown((v) => (seen = v)) });
    expect(seen!.replaces).toMatchObject({ id: first.key.id });
    // No --name this time: the key keeps the name it had, not the hostname.
    expect(first.key.name).toBe('first-name');
    expect(second.key.name).toBe('first-name');
    expect(await authenticateToken(first.token)).toBeNull();
    expect(await authenticateToken(second.token)).toMatchObject({ readOnly: true });
  });

  test('a token for another hub is not sent, so nothing is replaced', async () => {
    const other = encodeToken({ url: 'https://elsewhere.example.com', kid: 'k1', secret: 's'.repeat(43) });
    let seen: Awaited<ReturnType<typeof describeDeviceAuth>> | null = null;
    await deviceLogin({
      url, pollMs: 20, scopes: ['profiles:read'], currentToken: other,
      onCode: ({ userCode }) => setTimeout(async () => {
        seen = await describeDeviceAuth(userCode);
        await approveDeviceAuth(userCode, {}, url);
      }, 40),
    });
    expect(seen).not.toHaveProperty('replaces');
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
