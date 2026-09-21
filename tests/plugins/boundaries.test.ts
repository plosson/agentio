import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { relative } from 'path';

const ROOT = new URL('../../', import.meta.url).pathname;

async function serviceSources(): Promise<Array<{ path: string; source: string }>> {
  const files: Array<{ path: string; source: string }> = [];
  const glob = new Bun.Glob('src/plugins/**/*.ts');
  for await (const path of glob.scan({ cwd: ROOT, absolute: true })) {
    if (/\/src\/plugins\/(?:profile-host|declarative)\.ts$/.test(path)) continue;
    files.push({ path: relative(ROOT, path), source: await readFile(path, 'utf8') });
  }
  return files;
}

describe('plugin boundaries', () => {
  test('service plugins cannot persist or enumerate vault profiles directly', async () => {
    const offenders: string[] = [];
    for (const file of await serviceSources()) {
      if (/from ['"][^'"]*(?:config\/profile-store|auth\/token-store)['"]/.test(file.source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('service plugins cannot import privileged vault commands', async () => {
    const offenders: string[] = [];
    for (const file of await serviceSources()) {
      if (/from ['"][^'"]*(?:commands\/vault|vault\/vault)['"]/.test(file.source)) offenders.push(file.path);
    }
    expect(offenders).toEqual([]);
  });

  test('the public SDK remains types-only and independent of host internals', async () => {
    const source = await readFile(new URL('../../src/plugin-sdk/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/^export\s+\{[^}]*\}\s+from\s/m);
  });
});
