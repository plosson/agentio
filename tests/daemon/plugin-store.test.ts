import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withTempVault } from '../helpers/vault';
import { lockVault } from '../../src/vault/vault';
import { saveProfile } from '../../src/config/profile-store';
import { pointerPath } from '../../src/vault/pointer';
import {
  createStore,
  deleteStore,
  newStoreKey,
  openProfileStore,
  openStore,
  renameStore,
  storeDir,
  storesRoot,
  storeSegment,
  StoreUnavailable,
  STORE_KEY_FIELD,
} from '../../src/daemon/plugin-store';

const { home } = withTempVault('agentio-store-test-', () => ({}));

/** The reason a store call failed, or 'none'. */
async function reason(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return 'none';
  } catch (err) {
    return err instanceof StoreUnavailable ? err.reason : `other: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Every byte the store left on disk, WAL included. */
function bytesOnDisk(dir: string): string {
  return readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
}

describe('store segments', () => {
  test('names that would leave the plugin directory stay inside it', () => {
    expect(storeSegment('..')).toBe('%2E%2E');
    expect(storeSegment('.')).toBe('%2E');
    expect(storeSegment('a/../../b')).not.toContain('/');
    expect(storeSegment('a\\b')).not.toContain('\\');
    expect(storeSegment('\0')).toBe('%00');
  });

  test('names differing only in case stay apart on a case-insensitive file system', () => {
    const lower = storeSegment('work');
    const upper = storeSegment('Work');
    expect(lower).not.toBe(upper);
    expect(lower.toLowerCase()).not.toBe(upper.toLowerCase());
  });

  test('a literal percent cannot forge an encoded byte', () => {
    expect(storeSegment('%2E%2E')).not.toBe(storeSegment('..'));
  });

  test('non-ASCII names are encoded byte by byte', () => {
    expect(storeSegment('é')).toBe('%C3%A9');
  });

  test('an empty or overlong name is refused', () => {
    expect(() => storeSegment('')).toThrow('empty');
    expect(() => storeSegment('é'.repeat(40))).toThrow('too long');
  });

  test('a plugin id with a path in it is refused', async () => {
    await expect(storeDir('../etc', 'work')).rejects.toThrow('Invalid plugin id');
    await expect(storeDir('Whatsapp', 'work')).rejects.toThrow('Invalid plugin id');
  });

  test('stores live next to the vault', async () => {
    expect(await storeDir('whatsapp', 'work')).toBe(join(home(), '.config', 'agentio', 'stores', 'whatsapp', 'work'));
  });
});

describe('plugin store', () => {
  test('values round-trip, and a missing key is undefined', async () => {
    const { store } = await createStore('whatsapp', 'work');
    await store.set('creds', { a: 1, nested: { list: [1, 'two', null] } });
    await store.set('empty-string', '');
    await store.set('zero', 0);
    expect(await store.get('creds')).toEqual({ a: 1, nested: { list: [1, 'two', null] } });
    expect(await store.get('empty-string')).toBe('');
    expect(await store.get('zero')).toBe(0);
    expect(await store.get('absent')).toBeUndefined();
    store.close();
  });

  test('setting undefined deletes rather than storing something else', async () => {
    const { store } = await createStore('whatsapp', 'work');
    await store.set('k', 1);
    await store.set('k', undefined);
    expect(await store.get('k')).toBeUndefined();
    expect(await store.list('')).toEqual([]);
    store.close();
  });

  test('list matches the prefix only, sorted, and hides the check record', async () => {
    const { store } = await createStore('whatsapp', 'work');
    await store.set('msg:b', 2);
    await store.set('msg:a', 1);
    await store.set('msgx', 3);
    await store.set('other', 4);
    expect(await store.list('msg:')).toEqual([{ key: 'msg:a', value: 1 }, { key: 'msg:b', value: 2 }]);
    expect((await store.list('')).map((r) => r.key)).toEqual(['msg:a', 'msg:b', 'msgx', 'other']);
    await store.delete('msg:a');
    await store.delete('never-there');
    expect(await store.list('msg:')).toEqual([{ key: 'msg:b', value: 2 }]);
    store.close();
  });

  test('data survives a close and reopen with the same key', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    await store.set('chats', ['a']);
    store.close();
    const again = await openStore('whatsapp', 'work', key);
    expect(await again.get('chats')).toEqual(['a']);
    again.close();
  });

  test('neither record names nor values are readable on disk', async () => {
    const { store } = await createStore('whatsapp', 'work');
    await store.set('chat:33612345678@s.whatsapp.net', 'meet me at the station');
    store.close();
    const disk = bytesOnDisk(await storeDir('whatsapp', 'work'));
    expect(disk).not.toContain('33612345678');
    expect(disk).not.toContain('meet me');
  });

  test('a wrong, malformed or absent key is a key mismatch', async () => {
    const { store } = await createStore('whatsapp', 'work');
    store.close();
    expect(await reason(() => openStore('whatsapp', 'work', newStoreKey()))).toBe('key_mismatch');
    expect(await reason(() => openStore('whatsapp', 'work', 'short'))).toBe('key_mismatch');
    expect(await reason(() => openStore('whatsapp', 'work', undefined))).toBe('key_mismatch');
    expect(await reason(() => openStore('whatsapp', 'work', 42))).toBe('key_mismatch');
  });

  test('a store that was never created is missing', async () => {
    expect(await reason(() => openStore('whatsapp', 'nobody', newStoreKey()))).toBe('missing');
  });

  test('a file that is not a database cannot be opened', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    store.close();
    const dir = await storeDir('whatsapp', 'work');
    for (const f of readdirSync(dir)) writeFileSync(join(dir, f), 'garbage garbage garbage garbage garbage garbage garbage garbage garbage garbage');
    expect(await reason(() => openStore('whatsapp', 'work', key))).not.toBe('none');
  });

  test('a record moved to another record\'s slot does not decrypt', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    await store.set('a', 'value-a');
    await store.set('b', 'value-b');
    store.close();
    const db = new Database(join(await storeDir('whatsapp', 'work'), 'store.db'));
    const rows = db.query<{ id: string; blob: Uint8Array }, []>('SELECT id, blob FROM records').all();
    // Swap every blob one place along, so no record stays where it was sealed.
    rows.forEach((row, i) => db.query('UPDATE records SET blob = ? WHERE id = ?').run(rows[(i + 1) % rows.length]!.blob, row.id));
    db.close();
    expect(await reason(() => openStore('whatsapp', 'work', key))).toBe('key_mismatch');
  });

  test('a tampered record is corrupt, not silently a different value', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    await store.set('a', 'value-a');
    store.close();
    const db = new Database(join(await storeDir('whatsapp', 'work'), 'store.db'));
    for (const row of db.query<{ id: string; blob: Uint8Array }, []>('SELECT id, blob FROM records').all()) {
      const blob = Buffer.from(row.blob);
      blob[blob.length - 20] ^= 1;
      db.query('UPDATE records SET blob = ? WHERE id = ?').run(blob, row.id);
    }
    db.close();
    // The check record is tampered too, so the key no longer verifies.
    expect(await reason(() => openStore('whatsapp', 'work', key))).toBe('key_mismatch');
  });

  test('creating a store again replaces the old one and its key', async () => {
    const first = await createStore('whatsapp', 'work');
    await first.store.set('old', true);
    first.store.close();
    const second = await createStore('whatsapp', 'work');
    expect(await second.store.get('old')).toBeUndefined();
    second.store.close();
    expect(await reason(() => openStore('whatsapp', 'work', first.key))).toBe('key_mismatch');
    expect(second.key).not.toBe(first.key);
  });

  test('the store directory and file are private to the user', async () => {
    const { store } = await createStore('whatsapp', 'work');
    await store.set('k', 'v');
    const dir = await storeDir('whatsapp', 'work');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o077).toBe(0);
    store.close();
  });

  test('profiles of different plugins and names never share a store', async () => {
    const a = await createStore('whatsapp', 'work');
    const b = await createStore('whatsapp', 'Work');
    const c = await createStore('signal', 'work');
    await a.store.set('k', 'a');
    await b.store.set('k', 'b');
    await c.store.set('k', 'c');
    expect(await a.store.get('k')).toBe('a');
    expect(await b.store.get('k')).toBe('b');
    expect(await c.store.get('k')).toBe('c');
    [a, b, c].forEach((s) => s.store.close());
  });
});

describe('store lifecycle', () => {
  test('a store moves with its profile, key unchanged', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    await store.set('k', 'v');
    store.close();
    await renameStore('whatsapp', 'work', 'job');
    expect(await reason(() => openStore('whatsapp', 'work', key))).toBe('missing');
    const moved = await openStore('whatsapp', 'job', key);
    expect(await moved.get('k')).toBe('v');
    moved.close();
  });

  test('a rename replaces an orphan store left at the new name', async () => {
    const orphan = await createStore('whatsapp', 'job');
    orphan.store.close();
    const { key, store } = await createStore('whatsapp', 'work');
    store.close();
    await renameStore('whatsapp', 'work', 'job');
    (await openStore('whatsapp', 'job', key)).close();
    expect(await reason(() => openStore('whatsapp', 'job', orphan.key))).toBe('key_mismatch');
  });

  test('renaming a profile with no store, or to itself, does nothing', async () => {
    await renameStore('whatsapp', 'ghost', 'other');
    expect(existsSync(await storeDir('whatsapp', 'other'))).toBe(false);
    const { key, store } = await createStore('whatsapp', 'work');
    store.close();
    await renameStore('whatsapp', 'work', 'work');
    (await openStore('whatsapp', 'work', key)).close();
  });

  test('a deleted store is missing, and deleting twice is harmless', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    store.close();
    await deleteStore('whatsapp', 'work');
    await deleteStore('whatsapp', 'work');
    expect(await reason(() => openStore('whatsapp', 'work', key))).toBe('missing');
  });

  test('the key comes from the vault, and a locked vault opens nothing', async () => {
    const { key, store } = await createStore('whatsapp', 'work');
    store.close();
    await saveProfile('whatsapp', 'work', { [STORE_KEY_FIELD]: key });
    (await openProfileStore('whatsapp', 'work')).close();

    lockVault();
    delete process.env.AGENTIO_PASSPHRASE;
    await expect(openProfileStore('whatsapp', 'work')).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  test('a profile whose vault entry lost its key needs pairing', async () => {
    const { store } = await createStore('whatsapp', 'work');
    store.close();
    await saveProfile('whatsapp', 'work', { number: '+33600000000' });
    expect(await reason(() => openProfileStore('whatsapp', 'work'))).toBe('key_mismatch');
  });

  test('a vault pointing outside the temp directory is never written next to during tests', async () => {
    writeFileSync(pointerPath(), '/definitely/not/tmp/agentio.vault\n');
    expect(await storesRoot()).toBe('/definitely/not/tmp/stores');
    await expect(createStore('whatsapp', 'work')).rejects.toThrow('Refusing to write');
    await expect(deleteStore('whatsapp', 'work')).rejects.toThrow('Refusing to write');
  });
});
