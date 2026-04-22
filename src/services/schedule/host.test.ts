import { describe, expect, test } from 'bun:test';
import { getCurrentHost, hostMatches } from './host';

describe('getCurrentHost', () => {
  test('returns a non-empty string', () => {
    const h = getCurrentHost();
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('hostMatches', () => {
  test('returns true when host is unset', () => {
    expect(hostMatches({}, 'mac-1')).toBe(true);
    expect(hostMatches({ host: undefined }, 'mac-1')).toBe(true);
  });
  test('returns true when host matches current hostname', () => {
    expect(hostMatches({ host: 'mac-1' }, 'mac-1')).toBe(true);
  });
  test('returns false when host differs', () => {
    expect(hostMatches({ host: 'other-box' }, 'mac-1')).toBe(false);
  });
});
