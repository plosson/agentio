import { beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../helpers/vault';
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

  test('a request expires after the TTL for both sides', () => {
    const t0 = 1_000_000;
    const { userCode, deviceCode } = startDeviceAuth('box', t0);
    expect(describeDeviceAuth(userCode, t0 + DEVICE_AUTH_TTL_MS)).toMatchObject({ name: 'box' });
    expect(pollDeviceAuth(deviceCode, t0 + DEVICE_AUTH_TTL_MS)).toEqual({ status: 'pending' });
    expect(() => describeDeviceAuth(userCode, t0 + DEVICE_AUTH_TTL_MS + 1)).toThrow('expired');
    expect(() => pollDeviceAuth(deviceCode, t0 + DEVICE_AUTH_TTL_MS + 1)).toThrow('expired');
    // Expired on poll means forgotten: a later, in-time call is not revived.
    expect(() => pollDeviceAuth(deviceCode, t0)).toThrow('expired');
  });

  test('a decided request cannot be decided again', async () => {
    const a = startDeviceAuth('a');
    denyDeviceAuth(a.userCode);
    expect(() => denyDeviceAuth(a.userCode)).toThrow('expired');
    expect(() => describeDeviceAuth(a.userCode)).toThrow('expired');

    const b = startDeviceAuth('b');
    const key = await approveDeviceAuth(b.userCode, { name: 'b', allowedProfiles: '*', readOnly: false }, 'https://hub');
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

    const list = listDeviceAuth(t0 + 5000);
    expect(list.map((r) => r.userCode)).toEqual([first.userCode, second.userCode]);
    // The name is passed through as given; escaping is the page's job.
    expect(list[1].name).toBe('<img src=x onerror=alert(1)>');
    for (const r of list) {
      expect(Object.keys(r).sort()).toEqual(['createdAt', 'expiresAt', 'name', 'userCode']);
      expect(JSON.stringify(r)).not.toContain(first.deviceCode);
    }
  });

  test('expired requests leave the list at the TTL, not before', () => {
    const t0 = 3_000_000;
    const a = startDeviceAuth('a', t0);
    expect(listDeviceAuth(t0 + DEVICE_AUTH_TTL_MS).map((r) => r.userCode)).toEqual([a.userCode]);
    expect(listDeviceAuth(t0 + DEVICE_AUTH_TTL_MS + 1)).toEqual([]);
  });

  test('an empty hub lists nothing', () => {
    expect(listDeviceAuth()).toEqual([]);
  });
});
