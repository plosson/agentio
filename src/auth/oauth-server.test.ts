import { describe, expect, test } from 'bun:test';
import { launchBrowser, parseOAuthRedirect } from './oauth-server';

describe('parseOAuthRedirect', () => {
  test('pulls the code and state out of a pasted redirect URL', () => {
    expect(parseOAuthRedirect('http://localhost:3001/callback?code=abc123&state=st8', 'Google', 'st8')).toEqual({
      code: 'abc123',
      state: 'st8',
    });
  });

  test('accepts a bare code, trimmed', () => {
    expect(parseOAuthRedirect('  4/0AbCdEf  ', 'Google')).toEqual({ code: '4/0AbCdEf' });
  });

  test('rejects a state that does not match', () => {
    expect(() => parseOAuthRedirect('http://localhost:3001/callback?code=abc&state=other', 'GitHub', 'st8')).toThrow(
      /state mismatch/i,
    );
  });

  test('rejects a URL with no state when one was expected', () => {
    expect(() => parseOAuthRedirect('http://localhost:3001/callback?code=abc', 'GitHub', 'st8')).toThrow(
      /state mismatch/i,
    );
  });

  test('ignores state when the flow does not use one', () => {
    expect(parseOAuthRedirect('http://localhost:3001/callback?code=abc', 'Google')).toEqual({
      code: 'abc',
      state: undefined,
    });
  });

  test('surfaces a denial from the provider', () => {
    expect(() =>
      parseOAuthRedirect('http://localhost:3001/callback?error=access_denied&error_description=User+said+no', 'Google'),
    ).toThrow(/access_denied - User said no/);
  });

  test('explains a redirect URL that carries no code', () => {
    expect(() => parseOAuthRedirect('http://localhost:3001/callback', 'Google')).toThrow(/No "code" parameter/);
  });

  test('rejects empty input', () => {
    expect(() => parseOAuthRedirect('   ', 'Google')).toThrow(/authorization code is required/i);
  });
});

describe('launchBrowser', () => {
  // A headless box has no opener; spawning a missing executable throws, and that
  // must not take the OAuth flow down with it.
  test('reports failure instead of throwing when no opener exists', () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';

    try {
      expect(launchBrowser('https://example.com')).toBe(false);
    } finally {
      process.env.PATH = path;
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });
});
