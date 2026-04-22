import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { tmpdir, hostname, userInfo } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import {
  detectLegacy,
  migrateLegacy,
  legacyPaths,
} from './migrate';

let tempHome = '';
let savedHome = '';

beforeEach(async () => {
  savedHome = process.env.HOME || '';
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-migrate-test-'));
  process.env.HOME = tempHome;
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  process.env.HOME = savedHome;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

function writeLegacyTokensEncWithKey(path: string, data: object, key: Buffer): void {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  Bun.write(
    path,
    JSON.stringify({
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: enc.toString('hex'),
    })
  );
}

function legacyMachineKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-agentio-v1`;
  return scryptSync(machineId, 'agentio-salt', 32);
}

describe('migrate', () => {
  test('detectLegacy returns false when nothing is present', async () => {
    const { hasConfig, hasTokens } = await detectLegacy();
    expect(hasConfig).toBe(false);
    expect(hasTokens).toBe(false);
  });

  test('detectLegacy finds config.json and tokens.enc', async () => {
    const { configPath, tokensPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    await writeFile(tokensPath, 'anything', { mode: 0o600 });
    const { hasConfig, hasTokens } = await detectLegacy();
    expect(hasConfig).toBe(true);
    expect(hasTokens).toBe(true);
  });

  test('migrateLegacy reads config and decrypts tokens with the machine key', async () => {
    const { configPath, tokensPath } = legacyPaths();
    const config = { profiles: { gmail: [{ name: 'work' }] }, env: { FOO: 'bar' } };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    writeLegacyTokensEncWithKey(
      tokensPath,
      { gmail: { work: { token: 'xyz' } } },
      legacyMachineKey()
    );

    const result = await migrateLegacy();
    expect(result.config).toEqual(config);
    expect(result.credentials).toEqual({ gmail: { work: { token: 'xyz' } } });
    expect(result.tokensRecovered).toBe(true);
  });

  test('migrateLegacy renames legacy files to .bak after success', async () => {
    const { configPath, tokensPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    writeLegacyTokensEncWithKey(tokensPath, {}, legacyMachineKey());

    await migrateLegacy();

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(tokensPath)).toBe(false);
    expect(existsSync(configPath + '.bak')).toBe(true);
    expect(existsSync(tokensPath + '.bak')).toBe(true);
  });

  test('migrateLegacy returns tokensRecovered:false when tokens.enc is undecryptable', async () => {
    const { configPath, tokensPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    // Write a tokens.enc encrypted with a WRONG key (simulates hostname change)
    writeLegacyTokensEncWithKey(tokensPath, { gmail: { work: { token: 'x' } } }, randomBytes(32));

    const result = await migrateLegacy();
    expect(result.tokensRecovered).toBe(false);
    expect(result.credentials).toEqual({});
  });

  test('migrateLegacy returns tokensRecovered:false when tokens.enc missing', async () => {
    const { configPath } = legacyPaths();
    await writeFile(configPath, JSON.stringify({ profiles: {} }), { mode: 0o600 });
    const result = await migrateLegacy();
    expect(result.tokensRecovered).toBe(false);
    expect(result.credentials).toEqual({});
  });

  test('migrateLegacy throws when no config.json exists', async () => {
    await expect(migrateLegacy()).rejects.toThrow();
  });
});
