import { describe, expect, test } from 'bun:test';
import { abbrHome } from './output';

describe('abbrHome', () => {
  test('replaces $HOME prefix with ~', () => {
    expect(abbrHome('/Users/alice/projects/x', '/Users/alice')).toBe('~/projects/x');
  });
  test('returns ~ when path equals home', () => {
    expect(abbrHome('/Users/alice', '/Users/alice')).toBe('~');
  });
  test('leaves unrelated paths unchanged', () => {
    expect(abbrHome('/tmp/foo', '/Users/alice')).toBe('/tmp/foo');
  });
  test('does not match a prefix that is not a path boundary', () => {
    expect(abbrHome('/Users/alicia/x', '/Users/alice')).toBe('/Users/alicia/x');
  });
});
