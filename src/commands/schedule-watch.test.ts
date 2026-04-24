import { describe, expect, test } from 'bun:test';
import { addWatchedFolder, removeWatchedFolder } from './schedule-watch';
import type { Config } from '../types/config';

describe('addWatchedFolder', () => {
  test('appends when folder is new', () => {
    const c: Config = { profiles: {} };
    const out = addWatchedFolder(c, '/tmp/a', 'h1', 1000);
    expect(out.daemon?.scheduler?.watchedFolders).toEqual([
      { path: '/tmp/a', host: 'h1', addedAt: 1000 },
    ]);
  });

  test('is idempotent by path', () => {
    const c: Config = {
      profiles: {},
      daemon: { scheduler: { watchedFolders: [{ path: '/tmp/a', addedAt: 1 }] } },
    };
    const out = addWatchedFolder(c, '/tmp/a', 'h1', 2);
    expect(out.daemon?.scheduler?.watchedFolders?.length).toBe(1);
  });

  test('omits host field when not provided', () => {
    const c: Config = { profiles: {} };
    const out = addWatchedFolder(c, '/tmp/a', undefined, 5);
    expect(out.daemon?.scheduler?.watchedFolders?.[0]).toEqual({
      path: '/tmp/a', addedAt: 5,
    });
  });
});

describe('removeWatchedFolder', () => {
  test('removes by exact path', () => {
    const c: Config = {
      profiles: {},
      daemon: { scheduler: { watchedFolders: [
        { path: '/tmp/a', addedAt: 1 },
        { path: '/tmp/b', addedAt: 2 },
      ] } },
    };
    const out = removeWatchedFolder(c, '/tmp/a');
    expect(out.daemon?.scheduler?.watchedFolders).toEqual([
      { path: '/tmp/b', addedAt: 2 },
    ]);
  });

  test('is no-op when path not present', () => {
    const c: Config = {
      profiles: {},
      daemon: { scheduler: { watchedFolders: [{ path: '/tmp/a', addedAt: 1 }] } },
    };
    const out = removeWatchedFolder(c, '/tmp/zzz');
    expect(out.daemon?.scheduler?.watchedFolders?.length).toBe(1);
  });
});
