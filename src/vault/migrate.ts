import { readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, hostname, userInfo } from 'os';
import { join } from 'path';
import { createDecipheriv, scryptSync } from 'crypto';
import { CliError } from '../utils/errors';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

function configDir(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio');
}

export function legacyPaths(): { configPath: string; tokensPath: string } {
  const dir = configDir();
  return {
    configPath: join(dir, 'config.json'),
    tokensPath: join(dir, 'tokens.enc'),
  };
}

export async function detectLegacy(): Promise<{ hasConfig: boolean; hasTokens: boolean }> {
  const { configPath, tokensPath } = legacyPaths();
  return {
    hasConfig: existsSync(configPath),
    hasTokens: existsSync(tokensPath),
  };
}

function legacyMachineKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-agentio-v1`;
  return scryptSync(machineId, 'agentio-salt', 32);
}

function tryDecryptLegacyTokens(raw: string): StoredCredentials | null {
  try {
    const { iv, tag, data } = JSON.parse(raw);
    const key = legacyMachineKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(data, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf-8'));
  } catch {
    return null;
  }
}

export interface MigrateResult {
  config: Config;
  credentials: StoredCredentials;
  tokensRecovered: boolean;
}

/**
 * Read legacy config + tokens without side effects. Safe to call multiple
 * times. Call archiveLegacy() after the new vault has been successfully
 * written to preserve the originals as .bak files.
 */
export async function readLegacy(): Promise<MigrateResult> {
  const { configPath, tokensPath } = legacyPaths();

  if (!existsSync(configPath)) {
    throw new CliError(
      'NOT_FOUND',
      'No legacy config.json to migrate',
      'Run: agentio vault init for a fresh install'
    );
  }

  let config: Config;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw) as Config;
  } catch (err) {
    throw new CliError(
      'CONFIG_ERROR',
      `Failed to read legacy config.json: ${(err as Error).message}`,
      'Fix or remove the file, then run setup again'
    );
  }

  let credentials: StoredCredentials = {};
  let tokensRecovered = false;
  if (existsSync(tokensPath)) {
    const raw = await readFile(tokensPath, 'utf-8');
    const recovered = tryDecryptLegacyTokens(raw);
    if (recovered) {
      credentials = recovered;
      tokensRecovered = true;
    }
  }

  return { config, credentials, tokensRecovered };
}

/** Rename legacy files to .bak. Call only after the new vault is safely written. */
export async function archiveLegacy(): Promise<void> {
  const { configPath, tokensPath } = legacyPaths();
  if (existsSync(configPath)) {
    await rename(configPath, configPath + '.bak');
  }
  if (existsSync(tokensPath)) {
    await rename(tokensPath, tokensPath + '.bak');
  }
}

/** Back-compat wrapper: read then archive in one step. */
export async function migrateLegacy(): Promise<MigrateResult> {
  const result = await readLegacy();
  await archiveLegacy();
  return result;
}
