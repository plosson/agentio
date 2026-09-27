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
} from '../../src/vault/pointer';

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
    const { assertTestWritable } = await import('../../src/vault/pointer');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    expect(() => assertTestWritable(join(tmpdir(), 'x', 'vault.enc'), 'vault')).not.toThrow();
    expect(() => assertTestWritable('/Users/someone/.config/agentio/vault.enc', 'vault')).toThrow(/Refusing to write a vault/);
  });

  test('pointer writes and deletes are guarded', async () => {
    const { writePointer, deletePointer } = await import('../../src/vault/pointer');
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

describe('AGENTIO_HOME override', () => {
  let savedAgentioHome: string | undefined;

  beforeEach(() => {
    savedAgentioHome = process.env.AGENTIO_HOME;
  });

  afterEach(() => {
    if (savedAgentioHome === undefined) delete process.env.AGENTIO_HOME;
    else process.env.AGENTIO_HOME = savedAgentioHome;
  });

  test('replaces the whole config directory, ignoring HOME', async () => {
    const { configDir } = await import('../../src/vault/pointer');
    process.env.AGENTIO_HOME = join(tempHome, 'dev');
    expect(configDir()).toBe(join(tempHome, 'dev'));
    expect(pointerPath()).toBe(join(tempHome, 'dev', 'vault.path'));
  });

  test('a relative value resolves against the working directory, not HOME', async () => {
    const { configDir } = await import('../../src/vault/pointer');
    process.env.AGENTIO_HOME = '.dev-home';
    expect(configDir()).toBe(join(process.cwd(), '.dev-home'));
  });

  test('empty or blank values fall back to HOME, never to the working directory', async () => {
    const { configDir } = await import('../../src/vault/pointer');
    for (const value of ['', '   ', '\t\n']) {
      process.env.AGENTIO_HOME = value;
      expect(configDir()).toBe(join(tempHome, '.config', 'agentio'));
    }
  });

  test('surrounding whitespace is not kept as part of the path', async () => {
    const { configDir } = await import('../../src/vault/pointer');
    process.env.AGENTIO_HOME = `  ${join(tempHome, 'dev')}  `;
    expect(configDir()).toBe(join(tempHome, 'dev'));
  });

  test('pointer writes land in the override and leave HOME untouched', async () => {
    process.env.AGENTIO_HOME = join(tempHome, 'dev');
    await writePointer('/some/vault.enc');
    expect(existsSync(join(tempHome, 'dev', 'vault.path'))).toBe(true);
    expect(existsSync(join(tempHome, '.config', 'agentio', 'vault.path'))).toBe(false);
  });

  test('the test-write guard still applies to an override outside the temp directory', async () => {
    process.env.AGENTIO_HOME = '/definitely/not/a/temp/dir';
    await expect(writePointer('/x/vault.enc')).rejects.toThrow(/Refusing/);
  });
});
