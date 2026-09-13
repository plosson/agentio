import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, dirname, isAbsolute, relative } from 'path';

export function configDir(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio');
}

/**
 * Under `bun test`, files in the config directory (vault, pointer, token) may
 * only ever be written inside the OS temp directory. A test that forgets to
 * point HOME at a temp dir must fail loudly, not touch the real, synced files.
 */
export function assertTestWritable(path: string, what: string): void {
  if (process.env.NODE_ENV !== 'test') return;
  const rel = relative(tmpdir(), path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write a ${what} outside ${tmpdir()} during tests: ${path}`);
  }
}

export function pointerPath(): string {
  return join(configDir(), 'vault.path');
}

export async function pointerExists(): Promise<boolean> {
  return existsSync(pointerPath());
}

export async function readPointer(): Promise<string | null> {
  const path = pointerPath();
  if (!existsSync(path)) return null;
  const content = await readFile(path, 'utf-8');
  return content.trim();
}

export async function writePointer(vaultPath: string): Promise<void> {
  assertTestWritable(pointerPath(), 'vault pointer');
  const dir = dirname(pointerPath());
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(pointerPath(), vaultPath + '\n', { mode: 0o600 });
}

export async function deletePointer(): Promise<void> {
  const path = pointerPath();
  assertTestWritable(path, 'vault pointer');
  if (existsSync(path)) {
    await unlink(path);
  }
}
