import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pluginCachePath, readPluginCache, writePluginCache } from '../../src/config/plugin-cache';

let home = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  home = await mkdtemp(join(tmpdir(), 'agentio-plugin-cache-'));
  process.env.HOME = home;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe('plugin cache', () => {
  test('keeps plugin data in private host-owned namespaced paths', async () => {
    const path = pluginCachePath('gchat', 'person@example.com', 'directory');
    expect(path.startsWith(join(home, '.config', 'agentio', 'cache', 'gchat'))).toBe(true);
    expect(path).not.toContain('person@example.com');

    await writePluginCache('gchat', 'person@example.com', 'directory', { users: { one: 1 } });
    expect(await readPluginCache<{ users: { one: number } }>('gchat', 'person@example.com', 'directory')).toEqual({ users: { one: 1 } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  });

  test('treats missing and corrupt cache entries as misses', async () => {
    expect(await readPluginCache('gchat', 'person@example.com', 'directory')).toBeNull();
    const path = pluginCachePath('gchat', 'person@example.com', 'directory');
    await writePluginCache('gchat', 'person@example.com', 'directory', { ok: true });
    await writeFile(path, '{broken');
    expect(await readPluginCache('gchat', 'person@example.com', 'directory')).toBeNull();
  });

  test('refuses path traversal in plugin-controlled segments', () => {
    expect(() => pluginCachePath('../gchat', 'scope', 'directory')).toThrow(/Invalid plugin cache/);
    expect(() => pluginCachePath('gchat', 'scope', '../directory')).toThrow(/Invalid plugin cache/);
  });
});
