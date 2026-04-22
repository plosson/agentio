import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

function configDir(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio');
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
  const dir = dirname(pointerPath());
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(pointerPath(), vaultPath + '\n', { mode: 0o600 });
}

export async function deletePointer(): Promise<void> {
  const path = pointerPath();
  if (existsSync(path)) {
    await unlink(path);
  }
}
