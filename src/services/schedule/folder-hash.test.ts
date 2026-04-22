import { describe, expect, test } from 'bun:test';
import { folderHash } from './folder-hash';

describe('folderHash', () => {
  test('is deterministic', () => {
    expect(folderHash('/Users/foo/proj')).toBe(folderHash('/Users/foo/proj'));
  });
  test('differs for different paths', () => {
    expect(folderHash('/Users/foo/a')).not.toBe(folderHash('/Users/foo/b'));
  });
  test('is hex', () => {
    expect(folderHash('/x')).toMatch(/^[0-9a-f]+$/);
  });
});
