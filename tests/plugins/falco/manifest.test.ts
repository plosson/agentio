import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexManifest, resolveBasename } from '../../../src/plugins/falco/commands';
import { loadManifest, saveManifest } from '../../../src/plugins/falco/manifest';

/** Collect the renames a reconciliation asks for, without touching a disk. */
function recorder() {
  const moves: Array<[string, string]> = [];
  return {
    moves,
    onRename: async (from: string, to: string) => {
      moves.push([from, to]);
    },
  };
}

describe('falco manifest reconciliation', () => {
  test('assigns and remembers a basename for a new document', async () => {
    const manifest = { entries: {} as Record<string, string> };
    const index = indexManifest(manifest.entries);
    const { onRename, moves } = recorder();

    const result = await resolveBasename('id-1', '2026-07-14_acme_1', manifest, index, onRename);

    expect(result).toEqual({ basename: '2026-07-14_acme_1', renamed: false });
    expect(manifest.entries['id-1']).toBe('2026-07-14_acme_1');
    expect(moves).toBeEmpty();
  });

  test('is a no-op on a second run with unchanged metadata', async () => {
    const manifest = { entries: { 'id-1': '2026-07-14_acme_1' } };
    const index = indexManifest(manifest.entries);
    const { onRename, moves } = recorder();

    const result = await resolveBasename('id-1', '2026-07-14_acme_1', manifest, index, onRename);

    expect(result.renamed).toBe(false);
    expect(moves).toBeEmpty();
  });

  test('renames on disk when upstream metadata changes the derived name', async () => {
    const manifest = { entries: { 'id-1': '2026-07-14_acme_1' } };
    const index = indexManifest(manifest.entries);
    const { onRename, moves } = recorder();

    const result = await resolveBasename('id-1', '2026-07-15_acme-bv_1', manifest, index, onRename);

    expect(result).toEqual({ basename: '2026-07-15_acme-bv_1', renamed: true });
    expect(moves).toEqual([['2026-07-14_acme_1', '2026-07-15_acme-bv_1']]);
    expect(manifest.entries['id-1']).toBe('2026-07-15_acme-bv_1');
  });

  test('keeps two documents apart when they derive the same name', async () => {
    const manifest = { entries: {} as Record<string, string> };
    const index = indexManifest(manifest.entries);
    const { onRename } = recorder();

    const first = await resolveBasename('id-1', '2026-07-14_acme_1', manifest, index, onRename);
    const second = await resolveBasename('id-2', '2026-07-14_acme_1', manifest, index, onRename);

    expect(first.basename).toBe('2026-07-14_acme_1');
    expect(second.basename).toBe('2026-07-14_acme_1_2');
    expect(manifest.entries).toEqual({ 'id-1': '2026-07-14_acme_1', 'id-2': '2026-07-14_acme_1_2' });
  });

  test('a document keeps its own name even when it is the one that collided', async () => {
    const manifest = { entries: { 'id-1': '2026-07-14_acme_1' } };
    const index = indexManifest(manifest.entries);
    const { onRename, moves } = recorder();

    // Recomputing the same name for the same id must not append a suffix.
    const result = await resolveBasename('id-1', '2026-07-14_acme_1', manifest, index, onRename);

    expect(result.basename).toBe('2026-07-14_acme_1');
    expect(moves).toBeEmpty();
  });
});

describe('falco manifest persistence', () => {
  test('round-trips through the target directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'falco-manifest-'));
    const manifest = await loadManifest(directory);
    expect(manifest.entries).toEqual({});

    manifest.entries['id-1'] = '2026-07-14_acme_1';
    await saveManifest(directory, manifest);

    const reloaded = await loadManifest(directory);
    expect(reloaded.entries).toEqual({ 'id-1': '2026-07-14_acme_1' });
    expect(reloaded.version).toBe(1);
  });

  test('treats an unreadable manifest as empty rather than failing the sync', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'falco-manifest-'));
    await writeFile(join(directory, '.manifest.json'), 'not json');

    expect((await loadManifest(directory)).entries).toEqual({});
  });

  test('hides the manifest from a plain directory listing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'falco-manifest-'));
    await saveManifest(directory, { version: 1, updated_at: new Date().toISOString(), entries: {} });

    const visible = (await readdir(directory)).filter((name) => !name.startsWith('.'));
    expect(visible).toBeEmpty();
  });
});
