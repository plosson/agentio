import { beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
import { authenticateToken, createApiKey, listApiKeys, rotateApiKey } from '../../src/auth/api-keys';
import {
  DEVICE_AUTH_TTL_MS,
  approveDeviceAuth,
  denyDeviceAuth,
  describeDeviceAuth,
  listDeviceAuth,
  normalizeUserCode,
  pollDeviceAuth,
  resetDeviceAuth,
  startDeviceAuth,
} from '../../src/daemon/device-auth';

withTempVault('agentio-device-test-', () => ({ config: { profiles: { slack: [{ name: 'ops' }] } } }));
beforeEach(resetDeviceAuth);

describe('device auth', () => {
  test('codes are normalised from whatever the owner typed', () => {
    expect(normalizeUserCode('wdjb-mjht')).toBe('WDJB-MJHT');
    expect(normalizeUserCode(' wdjb mjht ')).toBe('WDJB-MJHT');
    expect(normalizeUserCode('WDJBMJHT')).toBe('WDJB-MJHT');
    expect(normalizeUserCode('short')).toBe('SHORT');
  });

  test('a request expires after the TTL for both sides', async () => {
    const t0 = 1_000_000;
    const { userCode, deviceCode } = startDeviceAuth('box', t0);
    expect(await describeDeviceAuth(userCode, t0 + DEVICE_AUTH_TTL_MS)).toMatchObject({ name: 'box' });
    expect(pollDeviceAuth(deviceCode, t0 + DEVICE_AUTH_TTL_MS)).toEqual({ status: 'pending' });
    await expect(describeDeviceAuth(userCode, t0 + DEVICE_AUTH_TTL_MS + 1)).rejects.toThrow('expired');
    expect(() => pollDeviceAuth(deviceCode, t0 + DEVICE_AUTH_TTL_MS + 1)).toThrow('expired');
    // Expired on poll means forgotten: a later, in-time call is not revived.
    expect(() => pollDeviceAuth(deviceCode, t0)).toThrow('expired');
  });

  test('a decided request cannot be decided again', async () => {
    const a = startDeviceAuth('a');
    denyDeviceAuth(a.userCode);
    expect(() => denyDeviceAuth(a.userCode)).toThrow('expired');
    await expect(describeDeviceAuth(a.userCode)).rejects.toThrow('expired');

    const b = startDeviceAuth('b');
    const { key } = await approveDeviceAuth(b.userCode, { name: 'b', allowedProfiles: '*', readOnly: false }, 'https://hub');
    await expect(approveDeviceAuth(b.userCode, { name: 'b', allowedProfiles: '*', readOnly: false }, 'https://hub')).rejects.toThrow('expired');
    expect(pollDeviceAuth(b.deviceCode)).toMatchObject({ status: 'approved', key: { id: key.id } });
  });

  test('a bad scope on approve leaves the request pending', async () => {
    const { userCode, deviceCode } = startDeviceAuth('c');
    await expect(approveDeviceAuth(userCode, { name: 'c', allowedProfiles: ['nope/x'], readOnly: false }, 'https://hub')).rejects.toThrow('Unknown profile');
    expect(pollDeviceAuth(deviceCode)).toMatchObject({ status: 'pending' });
  });

  test('the store is capped and names are validated', () => {
    expect(() => startDeviceAuth('')).toThrow('name');
    expect(() => startDeviceAuth('x'.repeat(65))).toThrow('name');
    for (let i = 0; i < 100; i++) startDeviceAuth('n');
    expect(() => startDeviceAuth('one more')).toThrow('Too many');
  });

  test('the owner sees pending requests only, oldest first, without device codes', async () => {
    const t0 = 2_000_000;
    const first = startDeviceAuth('first', t0);
    const second = startDeviceAuth('<img src=x onerror=alert(1)>', t0 + 1000);
    const denied = startDeviceAuth('denied', t0 + 2000);
    const approved = startDeviceAuth('approved', t0 + 3000);
    denyDeviceAuth(denied.userCode, t0 + 4000);
    await approveDeviceAuth(approved.userCode, { name: 'approved', allowedProfiles: '*', readOnly: true }, 'https://hub.example.com', t0 + 4000);

    const list = await listDeviceAuth(t0 + 5000);
    expect(list.map((r) => r.userCode)).toEqual([first.userCode, second.userCode]);
    // The name is passed through as given; escaping is the page's job.
    expect(list[1].name).toBe('<img src=x onerror=alert(1)>');
    for (const r of list) {
      expect(Object.keys(r).sort()).toEqual(['createdAt', 'expiresAt', 'name', 'userCode']);
      expect(JSON.stringify(r)).not.toContain(first.deviceCode);
    }
  });

  test('expired requests leave the list at the TTL, not before', async () => {
    const t0 = 3_000_000;
    const a = startDeviceAuth('a', t0);
    expect((await listDeviceAuth(t0 + DEVICE_AUTH_TTL_MS)).map((r) => r.userCode)).toEqual([a.userCode]);
    expect(await listDeviceAuth(t0 + DEVICE_AUTH_TTL_MS + 1)).toEqual([]);
  });

  test('an empty hub lists nothing', async () => {
    expect(await listDeviceAuth()).toEqual([]);
  });

  const HUB = 'https://hub.example.com';
  const machineKey = (name = 'old-laptop') => createApiKey({ name, allowedProfiles: ['slack/ops'], readOnly: true }, HUB);

  test('requested scopes are validated, stored canonically, echoed and shown', async () => {
    const start = startDeviceAuth('box', Date.now(), { scopes: ['profiles:manage', 'profiles:write'] });
    expect(start.scopes).toEqual(['profiles:write', 'profiles:manage']);
    expect(await describeDeviceAuth(start.userCode)).toMatchObject({ name: 'box', scopes: ['profiles:write', 'profiles:manage'] });
    expect(startDeviceAuth('plain')).not.toHaveProperty('scopes');
  });

  test('a bad scope list or flag stores nothing', async () => {
    expect(() => startDeviceAuth('box', Date.now(), { scopes: ['profiles:admin'] })).toThrow('Unknown scope');
    expect(() => startDeviceAuth('box', Date.now(), { scopes: [] })).toThrow('scopes');
    expect(() => startDeviceAuth('box', Date.now(), { nameIsDefault: 'yes' })).toThrow('nameIsDefault');
    expect(await listDeviceAuth()).toEqual([]);
  });

  test('a scoped approval ignores what the owner\'s body asks', async () => {
    const { userCode, deviceCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:write', 'profiles:manage'] });
    const { key } = await approveDeviceAuth(userCode, { name: 'evil', allowedProfiles: ['slack/ops'], readOnly: true, canManageProfiles: false }, HUB);
    expect(key).toMatchObject({ name: 'box', allowedProfiles: '*', readOnly: false, canManageProfiles: true });
    expect(pollDeviceAuth(deviceCode)).toMatchObject({ status: 'approved', key: { id: key.id } });
  });

  test('a scoped read-only request gets a read-only key that cannot manage profiles', async () => {
    const { userCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:read'] });
    const { key } = await approveDeviceAuth(userCode, {}, HUB);
    expect(key).toMatchObject({ allowedProfiles: '*', readOnly: true, canManageProfiles: false });
  });

  test('a replacing request shows the key it replaces and revokes it on approval', async () => {
    const old = await machineKey();
    const { userCode, deviceCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:write'], replaces: old.token, nameIsDefault: true });
    const view = await describeDeviceAuth(userCode);
    // The CLI only defaulted its name, so the key keeps the name the owner knows.
    expect(view).toMatchObject({ name: 'old-laptop', replaces: { id: old.key.id, name: 'old-laptop', createdAt: old.key.createdAt } });
    expect(JSON.stringify(view)).not.toContain(old.token);

    const { key, replaced } = await approveDeviceAuth(userCode, {}, HUB);
    expect(replaced?.id).toBe(old.key.id);
    expect(key.name).toBe('old-laptop');
    expect(await authenticateToken(old.token)).toBeNull();
    expect((await listApiKeys()).map((k) => k.id)).toEqual([key.id]);
    expect(pollDeviceAuth(deviceCode)).toMatchObject({ status: 'approved', key: { id: key.id } });
  });

  test('a name the user chose wins over the replaced key\'s name', async () => {
    const old = await machineKey();
    const { userCode } = startDeviceAuth('build-box', Date.now(), { scopes: ['profiles:read'], replaces: old.token, nameIsDefault: false });
    expect((await describeDeviceAuth(userCode)).name).toBe('build-box');
    expect((await approveDeviceAuth(userCode, {}, HUB)).key.name).toBe('build-box');
  });

  test('a request without scopes still replaces, with the owner\'s chosen access', async () => {
    const old = await machineKey();
    const { userCode } = startDeviceAuth('box', Date.now(), { replaces: old.token, nameIsDefault: true });
    const view = await describeDeviceAuth(userCode);
    expect(view).not.toHaveProperty('scopes');
    const { key, replaced } = await approveDeviceAuth(userCode, { name: view.name, allowedProfiles: ['slack/ops'], readOnly: true }, HUB);
    expect(replaced?.id).toBe(old.key.id);
    expect(key).toMatchObject({ name: 'old-laptop', allowedProfiles: ['slack/ops'], readOnly: true });
  });

  test('denying or letting a replacing request expire keeps the old key working', async () => {
    const old = await machineKey();
    const t0 = Date.now();
    const a = startDeviceAuth('box', t0, { replaces: old.token });
    denyDeviceAuth(a.userCode);
    const expired = startDeviceAuth('box', t0 - DEVICE_AUTH_TTL_MS - 1, { replaces: old.token });
    await expect(approveDeviceAuth(expired.userCode, {}, HUB)).rejects.toThrow('expired');
    expect(await authenticateToken(old.token)).toEqual(old.key);
  });

  test('a deny that lands while an approval is in flight is refused, never silently lost', async () => {
    const old = await machineKey();
    const { userCode, deviceCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:write'], replaces: old.token });
    const approval = approveDeviceAuth(userCode, {}, HUB);
    expect(() => denyDeviceAuth(userCode)).toThrow('expired');
    await expect(describeDeviceAuth(userCode)).rejects.toThrow('expired');
    expect(await listDeviceAuth()).toEqual([]);
    expect(pollDeviceAuth(deviceCode)).toEqual({ status: 'pending' });
    const { key } = await approval;
    expect(await authenticateToken(old.token)).toBeNull();
    expect(pollDeviceAuth(deviceCode)).toMatchObject({ status: 'approved', key: { id: key.id } });
  });

  test('an approval that arrives after a deny is refused and the old key keeps working', async () => {
    const old = await machineKey();
    const { userCode, deviceCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:write'], replaces: old.token });
    denyDeviceAuth(userCode);
    await expect(approveDeviceAuth(userCode, {}, HUB)).rejects.toThrow('expired');
    expect(await authenticateToken(old.token)).toEqual(old.key);
    expect(pollDeviceAuth(deviceCode)).toEqual({ status: 'denied' });
  });

  test('two concurrent approvals create exactly one key', async () => {
    const { userCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:read'] });
    const results = await Promise.allSettled([approveDeviceAuth(userCode, {}, HUB), approveDeviceAuth(userCode, {}, HUB)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await listApiKeys()).toHaveLength(1);
  });

  test('a garbage or unknown token is a new machine, without an error', async () => {
    const other = await machineKey('desktop');
    for (const replaces of ['garbage', 42, other.token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))]) {
      const { userCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:read'], replaces });
      expect(await describeDeviceAuth(userCode)).not.toHaveProperty('replaces');
      expect((await approveDeviceAuth(userCode, {}, HUB)).replaced).toBeNull();
    }
    expect(await authenticateToken(other.token)).toEqual(other.key);
  });

  test('a key rotated after the request is not revoked', async () => {
    const old = await machineKey();
    const { userCode } = startDeviceAuth('box', Date.now(), { scopes: ['profiles:read'], replaces: old.token, nameIsDefault: true });
    const rotated = await rotateApiKey(old.key.id, HUB);
    const { replaced, key } = await approveDeviceAuth(userCode, {}, HUB);
    expect(replaced).toBeNull();
    // Nothing proves the old name any more, so the request's own name stays.
    expect(key.name).toBe('box');
    expect(await authenticateToken(rotated.token)).toMatchObject({ id: old.key.id });
  });
});
