import { describe, expect, test } from 'bun:test';
import { SCOPES, scopeAccess, validateScopes } from '../../src/auth/scopes';

describe('scopes', () => {
  test('known scopes come back de-duplicated in canonical order', () => {
    expect(validateScopes(['profiles:manage', 'profiles:write', 'profiles:manage'])).toEqual(['profiles:write', 'profiles:manage']);
    expect(validateScopes([...SCOPES].reverse())).toEqual([...SCOPES]);
  });

  test('anything but a non-empty list of known scope strings is refused', () => {
    const bad: unknown[] = [undefined, null, 'profiles:read', [], [42], [null], {}, ['profiles:admin'], ['PROFILES:READ'], [' profiles:read'], ['profiles:read', 'x']];
    for (const input of bad) expect(() => validateScopes(input), JSON.stringify(input)).toThrow();
  });

  test('the error names the unknown scopes and lists the known ones', () => {
    expect(() => validateScopes(['profiles:admin'])).toThrow('Unknown scope: profiles:admin');
    try {
      validateScopes(['a', 'b', 'profiles:read']);
      throw new Error('not thrown');
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_PARAMS', message: 'Unknown scopes: a, b', suggestion: 'Known scopes: profiles:read, profiles:write, profiles:manage' });
    }
  });

  test('a flood of entries is refused before it is echoed anywhere', () => {
    expect(() => validateScopes(Array(17).fill('profiles:read'))).toThrow('at most 16');
    expect(validateScopes(Array(16).fill('profiles:read'))).toEqual(['profiles:read']);
  });

  test('every scope means every profile; write unlocks writes; manage unlocks profile management', () => {
    expect(scopeAccess(['profiles:read'])).toEqual({ allowedProfiles: '*', readOnly: true, canManageProfiles: false });
    expect(scopeAccess(['profiles:write'])).toEqual({ allowedProfiles: '*', readOnly: false, canManageProfiles: false });
    expect(scopeAccess(['profiles:manage'])).toEqual({ allowedProfiles: '*', readOnly: true, canManageProfiles: true });
    expect(scopeAccess(['profiles:read', 'profiles:write', 'profiles:manage'])).toEqual({ allowedProfiles: '*', readOnly: false, canManageProfiles: true });
  });
});
