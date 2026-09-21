import { createHash, randomBytes } from 'crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function cacheRoot(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio', 'cache');
}

function segment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`Invalid plugin cache ${label}: ${value}`);
  return value;
}

/** A host-owned cache path. Scope is hashed so account identifiers are not exposed in filenames. */
export function pluginCachePath(pluginId: string, scope: string, name: string): string {
  const scopeHash = createHash('sha256').update(scope).digest('hex').slice(0, 24);
  return join(cacheRoot(), segment(pluginId, 'plugin id'), scopeHash, `${segment(name, 'name')}.json`);
}

export async function readPluginCache<T>(pluginId: string, scope: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(pluginCachePath(pluginId, scope, name), 'utf8')) as T;
  } catch {
    // Caches are disposable: absence and corruption both mean a fresh fetch.
    return null;
  }
}

/** Write a cache atomically with private directory and file permissions. */
export async function writePluginCache(pluginId: string, scope: string, name: string, value: unknown): Promise<void> {
  const path = pluginCachePath(pluginId, scope, name);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
