import { beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../vault/test-helpers';
import {
  DEVICE_AUTH_TTL_MS,
  approveDeviceAuth,
  denyDeviceAuth,
  describeDeviceAuth,
  normalizeUserCode,
  pollDeviceAuth,
  resetDeviceAuth,
  startDeviceAuth,
} from './device-auth';

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
    expect(pollDeviceAuth(deviceCode, t0 + DEVICE_AUTH_TTL_MS)).toEqual({ status: 'pending', interval: 3 });
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
});
