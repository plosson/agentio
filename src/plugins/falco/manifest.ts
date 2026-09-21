import { join } from 'node:path';
import { chmod } from 'node:fs/promises';

export type Manifest = {
  version: 1;
  updated_at: string; // ISO timestamp
  // Maps the Falco document id (UUID) to the basename used on disk (no extension).
  entries: Record<string, string>;
};

const MANIFEST_NAME = '.manifest.json';

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_NAME);
}

export async function loadManifest(dir: string): Promise<Manifest> {
  const path = manifestPath(dir);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { version: 1, updated_at: new Date().toISOString(), entries: {} };
  }
  try {
    const raw = await file.text();
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (
      parsed &&
      parsed.version === 1 &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      return {
        version: 1,
        updated_at: parsed.updated_at ?? new Date().toISOString(),
        entries: parsed.entries as Record<string, string>,
      };
    }
  } catch {}
  return { version: 1, updated_at: new Date().toISOString(), entries: {} };
}

export async function saveManifest(dir: string, manifest: Manifest): Promise<void> {
  const path = manifestPath(dir);
  const out = { ...manifest, updated_at: new Date().toISOString() };
  await Bun.write(path, JSON.stringify(out, null, 2));
  await chmod(path, 0o600);
}
