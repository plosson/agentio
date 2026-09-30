import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, relative, isAbsolute } from 'path';
import { withTempVault } from './vault';
import { configDir } from '../../src/vault/pointer';
import { isRemoteMode, resetRemoteCache } from '../../src/auth/remote';
import { saveProfile } from '../../src/config/profile-store';
import { loadVault } from '../../src/vault/vault';

/**
 * The isolation `withTempVault` promises: every test gets its own config
 * folder under the OS temp dir, whatever the shell exported, and leaves the
 * environment exactly as it found it.
 */

const isUnderTmp = (path: string) => {
  const rel = relative(tmpdir(), path);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

describe('per-test folder', () => {
  withTempVault('agentio-iso-', () => ({}));
  const seen: string[] = [];

  test('configDir is under the temp dir, never the real one', () => {
    const dir = configDir();
    expect(isUnderTmp(dir)).toBe(true);
    expect(dir).not.toBe(join(homedir(), '.config', 'agentio'));
    seen.push(dir);
  });

  test('the next test gets a different folder', () => {
    seen.push(configDir());
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('shell values set before the test', () => {
  const decoy = mkdtempSync(join(tmpdir(), 'agentio-decoy-'));
  const before: Record<string, string | undefined> = {};
  const after: Record<string, string | undefined>[] = [];

  beforeEach(() => {
    before.HOME = process.env.HOME;
    before.AGENTIO_HOME = process.env.AGENTIO_HOME;
    before.AGENTIO_TOKEN = process.env.AGENTIO_TOKEN;
    process.env.AGENTIO_HOME = decoy;
    process.env.AGENTIO_TOKEN = 'decoy-token';
    resetRemoteCache();
  });

  // Outer afterEach runs after withTempVault's, so it sees what was restored.
  afterEach(() => {
    after.push({
      HOME: process.env.HOME,
      AGENTIO_HOME: process.env.AGENTIO_HOME,
      AGENTIO_TOKEN: process.env.AGENTIO_TOKEN,
    });
    const restore = (name: string) => {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    };
    restore('AGENTIO_HOME');
    restore('AGENTIO_TOKEN');
    resetRemoteCache();
  });

  afterAll(() => rmSync(decoy, { recursive: true, force: true }));

  describe('inside withTempVault', () => {
    withTempVault('agentio-iso-', () => ({}));

    test('an exported AGENTIO_HOME does not win, and the decoy stays empty', () => {
      expect(configDir()).not.toBe(decoy);
      expect(isUnderTmp(configDir())).toBe(true);
      expect(configDir().startsWith(process.env.HOME!)).toBe(true);
      expect(readdirSync(decoy)).toEqual([]);
    });

    test('an exported AGENTIO_TOKEN does not switch on remote mode', () => {
      expect(process.env.AGENTIO_TOKEN).toBeUndefined();
      expect(isRemoteMode()).toBe(false);
    });
  });

  test('both runs restored HOME, AGENTIO_HOME and AGENTIO_TOKEN exactly', () => {
    expect(after).toHaveLength(2);
    for (const env of after) {
      expect(env.HOME).toBe(before.HOME);
      expect(env.AGENTIO_HOME).toBe(decoy);
      expect(env.AGENTIO_TOKEN).toBe('decoy-token');
    }
    expect(readdirSync(decoy)).toEqual([]);
  });
});

describe('unset variables stay unset', () => {
  const saved: Record<string, string | undefined> = {};
  const presence: boolean[][] = [];

  beforeAll(() => {
    saved.AGENTIO_HOME = process.env.AGENTIO_HOME;
    saved.AGENTIO_TOKEN = process.env.AGENTIO_TOKEN;
  });
  beforeEach(() => {
    delete process.env.AGENTIO_HOME;
    delete process.env.AGENTIO_TOKEN;
  });
  afterEach(() => {
    presence.push(['AGENTIO_HOME' in process.env, 'AGENTIO_TOKEN' in process.env]);
  });
  afterAll(() => {
    if (saved.AGENTIO_HOME !== undefined) process.env.AGENTIO_HOME = saved.AGENTIO_HOME;
    if (saved.AGENTIO_TOKEN !== undefined) process.env.AGENTIO_TOKEN = saved.AGENTIO_TOKEN;
  });

  describe('inside withTempVault', () => {
    withTempVault('agentio-iso-', () => ({}));
    test('AGENTIO_HOME is set for the test', () => {
      expect(process.env.AGENTIO_HOME).toBe(join(process.env.HOME!, '.config', 'agentio'));
    });
  });

  test('neither was left behind, not even as the empty string', () => {
    expect(presence).toEqual([[false, false]]);
  });
});

describe('token file cache', () => {
  withTempVault('agentio-iso-', () => ({}));

  test('a token file planted in one test makes that test remote', () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), 'token'), 'planted-token\n');
    expect(isRemoteMode()).toBe(true);
  });

  test('the next test does not inherit it', () => {
    expect(existsSync(join(configDir(), 'token'))).toBe(false);
    expect(isRemoteMode()).toBe(false);
  });
});

describe('save stays local', () => {
  withTempVault('agentio-iso-', () => ({}));
  const originalFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('no network in this test');
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('saveProfile writes the temp vault and makes no fetch', async () => {
    await saveProfile('discourse', 'iso', { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', username: 'u' });
    expect(calls).toBe(0);
    const vault = await loadVault();
    expect(vault.credentials.discourse?.iso).toBeDefined();
    expect(isUnderTmp(configDir())).toBe(true);
  });
});
