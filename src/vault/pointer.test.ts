import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  readPointer,
  writePointer,
  deletePointer,
  pointerPath,
  pointerExists,
} from './pointer';

let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-pointer-test-'));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('vault pointer', () => {
  test('pointerPath returns ~/.config/agentio/vault.path', () => {
    expect(pointerPath()).toBe(join(tempHome, '.config', 'agentio', 'vault.path'));
  });

  test('pointerExists false when absent', async () => {
    expect(await pointerExists()).toBe(false);
  });

  test('write then read returns the path', async () => {
    await writePointer('/some/vault.enc');
    expect(await readPointer()).toBe('/some/vault.enc');
  });

  test('pointerExists true after write', async () => {
    await writePointer('/some/vault.enc');
    expect(await pointerExists()).toBe(true);
  });

  test('readPointer returns null when absent', async () => {
    expect(await readPointer()).toBeNull();
  });

  test('deletePointer removes the file', async () => {
    await writePointer('/some/vault.enc');
    await deletePointer();
    expect(await pointerExists()).toBe(false);
    expect(existsSync(pointerPath())).toBe(false);
  });

  test('deletePointer is idempotent when absent', async () => {
    await deletePointer();
    await deletePointer();
  });

  test('writePointer trims trailing newlines on readback', async () => {
    await writePointer('/some/vault.enc');
    const raw = await Bun.file(pointerPath()).text();
    // File content can have a trailing newline, readPointer normalizes it
    expect(raw.trim()).toBe('/some/vault.enc');
    expect(await readPointer()).toBe('/some/vault.enc');
  });
});

/** The guard that keeps `bun test` away from the real config directory, on every path that changes it. */
describe('test write guard', () => {
  test('accepts paths under the temp directory and refuses the rest', async () => {
    const { assertTestWritable } = await import('./pointer');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    expect(() => assertTestWritable(join(tmpdir(), 'x', 'vault.enc'), 'vault')).not.toThrow();
    expect(() => assertTestWritable('/Users/someone/.config/agentio/vault.enc', 'vault')).toThrow(/Refusing to write a vault/);
  });

  test('pointer writes and deletes are guarded', async () => {
    const { writePointer, deletePointer } = await import('./pointer');
    const saved = process.env.HOME;
    process.env.HOME = '/definitely/not/a/temp/home';
    try {
      await expect(writePointer('/x/vault.enc')).rejects.toThrow(/Refusing/);
      await expect(deletePointer()).rejects.toThrow(/Refusing/);
    } finally {
      process.env.HOME = saved;
    }
  });
});
