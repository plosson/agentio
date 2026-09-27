import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';
import { existsSync, writeFileSync } from 'fs';
import { mkdir, rename, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { assertTestWritable, readPointer } from '../vault/pointer';
import { CliError } from '../utils/errors';
import { getCredentials } from '../auth/token-store';

/**
 * A store per plugin and profile, next to the vault, for the data a long-lived
 * session produces: auth state that changes on every message, an index of
 * chats, recent messages. None of it belongs in the vault, which stays small
 * and is written only when profiles or keys change.
 *
 * The plugin sees a key-value API and nothing else: not the path, not the
 * format. Only the daemon opens a store.
 *
 * Each store has its own random 256-bit key, kept in the vault with the
 * profile's credentials, so a locked vault leaves every store unreadable and a
 * passphrase change never touches them. Every record is encrypted on its own
 * with AES-256-GCM, so a write costs one small record. Record names are stored
 * as an HMAC, since they carry chat ids, which are phone numbers.
 */

export interface PluginStore {
  get<T = unknown>(key: string): Promise<NoInfer<T> | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every record whose key starts with `prefix`, sorted by key. */
  list<T = unknown>(prefix: string): Promise<Array<{ key: string; value: NoInfer<T> }>>;
}

/** A store the daemon holds open. */
export interface OpenStore extends PluginStore {
  close(): void;
}

/** Where the store's key lives in the profile's credentials. */
export const STORE_KEY_FIELD = 'storeKey';

/**
 * Why a store cannot be used. `missing` and `key_mismatch` both mean the
 * profile has to be paired again; `corrupt` is a record that fails to decrypt
 * in a store that otherwise opened.
 */
export class StoreUnavailable extends Error {
  constructor(public readonly reason: 'missing' | 'key_mismatch' | 'corrupt', message: string) {
    super(message);
    this.name = 'StoreUnavailable';
  }
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHECK_KEY = '\0check';
const CHECK_VALUE = 'agentio-store-v1';
const DB_FILE = 'store.db';
/** Leaves room under the usual 255-byte limit for a file name. */
const MAX_SEGMENT = 200;

export function newStoreKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * A profile name as one directory name. Lowercase letters, digits, `-` and `_`
 * stay as they are; every other byte becomes `%XX`. So `..` and `/` cannot
 * leave the plugin's directory, and `Work` and `work` stay apart on a
 * case-insensitive file system.
 */
export function storeSegment(name: string): string {
  let out = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += /[a-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (!out) throw new CliError('INVALID_PARAMS', 'A profile name cannot be empty');
  if (out.length > MAX_SEGMENT) {
    throw new CliError('INVALID_PARAMS', `Profile name "${name}" is too long for a session store`, 'Choose a shorter name');
  }
  return out;
}

/** `<vault directory>/stores`. */
export async function storesRoot(): Promise<string> {
  const vaultPath = await readPointer();
  if (!vaultPath) {
    throw new CliError('VAULT_NOT_CONFIGURED', 'agentio is not configured yet', 'Run `agentio vault init` first');
  }
  return join(dirname(vaultPath), 'stores');
}

/** `<vault directory>/stores/<plugin>/<profile>`. */
export async function storeDir(plugin: string, profile: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin)) throw new CliError('INVALID_PARAMS', `Invalid plugin id: ${plugin}`);
  return join(await storesRoot(), plugin, storeSegment(profile));
}

function subkeys(key: string): { enc: Buffer; mac: Buffer } {
  const master = Buffer.from(key, 'base64');
  if (master.length !== KEY_BYTES) throw new StoreUnavailable('key_mismatch', 'The store key is not a 256-bit key');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, KEY_BYTES));
  return { enc: derive('agentio-store-enc'), mac: derive('agentio-store-id') };
}

class SqliteStore implements OpenStore {
  private readonly db: Database;
  private readonly enc: Buffer;
  private readonly mac: Buffer;

  constructor(path: string, key: string) {
    ({ enc: this.enc, mac: this.mac } = subkeys(key));
    this.db = new Database(path, { strict: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, blob BLOB NOT NULL) WITHOUT ROWID');
  }

  private id(key: string): string {
    return createHmac('sha256', this.mac).update(key, 'utf8').digest('hex');
  }

  private seal(id: string, key: string, value: unknown): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.enc, iv);
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify({ k: key, v: value }), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]);
  }

  /** The record, or null when it does not decrypt under this key and id. */
  private open(id: string, blob: Uint8Array): { k: string; v: unknown } | null {
    const buf = Buffer.from(blob);
    if (buf.length < IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.enc, buf.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(id, 'utf8'));
      decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
      const plain = Buffer.concat([decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      return null;
    }
  }

  private read(key: string): { found: boolean; value?: unknown } {
    const id = this.id(key);
    const row = this.db.query<{ blob: Uint8Array }, [string]>('SELECT blob FROM records WHERE id = ?').get(id);
    if (!row) return { found: false };
    const record = this.open(id, row.blob);
    if (!record || record.k !== key) throw new StoreUnavailable('corrupt', 'A store record does not decrypt');
    return { found: true, value: record.v };
  }

  /** Whether the check record written at creation decrypts under this key. */
  verify(): void {
    let check;
    try {
      check = this.read(CHECK_KEY);
    } catch {
      throw new StoreUnavailable('key_mismatch', 'The store does not match its key');
    }
    if (!check.found || check.value !== CHECK_VALUE) throw new StoreUnavailable('key_mismatch', 'The store does not match its key');
  }

  writeCheck(): void {
    this.put(CHECK_KEY, CHECK_VALUE);
  }

  private put(key: string, value: unknown): void {
    const id = this.id(key);
    this.db.query('INSERT INTO records (id, blob) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob')
      .run(id, this.seal(id, key, value));
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.read(key).value as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    // JSON has no undefined; storing it would read back as a different value.
    if (value === undefined) return this.delete(key);
    this.put(key, value);
  }

  async delete(key: string): Promise<void> {
    this.db.query('DELETE FROM records WHERE id = ?').run(this.id(key));
  }

  async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    const out: Array<{ key: string; value: T }> = [];
    for (const row of this.db.query<{ id: string; blob: Uint8Array }, []>('SELECT id, blob FROM records').iterate()) {
      const record = this.open(row.id, row.blob);
      if (!record) throw new StoreUnavailable('corrupt', 'A store record does not decrypt');
      if (record.k !== CHECK_KEY && record.k.startsWith(prefix)) out.push({ key: record.k, value: record.v as T });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  close(): void {
    this.db.close();
  }
}

/** Replace whatever store the profile had with an empty one; returns it and its new key. */
export async function createStore(plugin: string, profile: string): Promise<{ key: string; store: OpenStore }> {
  const dir = await storeDir(plugin, profile);
  assertTestWritable(dir, 'plugin store');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // SQLite gives its WAL files the database file's mode, so creating it 0600 covers them too.
  const path = join(dir, DB_FILE);
  writeFileSync(path, '', { mode: 0o600 });
  const key = newStoreKey();
  const store = new SqliteStore(path, key);
  store.writeCheck();
  return { key, store };
}

/** Open a profile's store with the key the vault holds for it. */
export async function openStore(plugin: string, profile: string, key: unknown): Promise<OpenStore> {
  if (typeof key !== 'string' || !key) throw new StoreUnavailable('key_mismatch', 'The profile has no store key');
  const path = join(await storeDir(plugin, profile), DB_FILE);
  if (!existsSync(path)) throw new StoreUnavailable('missing', 'The profile has no store');
  assertTestWritable(path, 'plugin store');
  let store: SqliteStore;
  try {
    store = new SqliteStore(path, key);
  } catch (err) {
    if (err instanceof StoreUnavailable) throw err;
    throw new StoreUnavailable('corrupt', `The store cannot be opened: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    store.verify();
  } catch (err) {
    store.close();
    throw err;
  }
  return store;
}

/** Open a profile's store with the key read from the vault; VAULT_LOCKED while it is locked. */
export async function openProfileStore(plugin: string, profile: string): Promise<OpenStore> {
  const credentials = await getCredentials<Record<string, unknown>>(plugin, profile);
  return openStore(plugin, profile, credentials?.[STORE_KEY_FIELD]);
}

/** Move a profile's store with the profile. A store left at the new name is an orphan and is replaced. */
export async function renameStore(plugin: string, from: string, to: string): Promise<void> {
  const source = await storeDir(plugin, from);
  const target = await storeDir(plugin, to);
  if (source === target || !existsSync(source)) return;
  assertTestWritable(source, 'plugin store');
  assertTestWritable(target, 'plugin store');
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rename(source, target);
}

/**
 * Move a profile's store out of the way while it is paired again, so a
 * pairing that fails can put it back. Returns where it went, or null when
 * there was none. The name starts with a dot, which no encoded profile name
 * does, so it can never be taken for a profile's store.
 */
export async function setAsideStore(plugin: string, profile: string): Promise<string | null> {
  const dir = await storeDir(plugin, profile);
  if (!existsSync(dir)) return null;
  const aside = join(dirname(dir), `.aside-${storeSegment(profile)}-${randomBytes(4).toString('hex')}`);
  assertTestWritable(dir, 'plugin store');
  await rename(dir, aside);
  return aside;
}

/** Put a store set aside back, replacing whatever is there now. */
export async function restoreStore(plugin: string, profile: string, aside: string): Promise<void> {
  const dir = await storeDir(plugin, profile);
  assertTestWritable(dir, 'plugin store');
  await rm(dir, { recursive: true, force: true });
  await rename(aside, dir);
}

/** Drop a store set aside, once the pairing that replaced it succeeded. */
export async function discardStore(aside: string): Promise<void> {
  assertTestWritable(aside, 'plugin store');
  await rm(aside, { recursive: true, force: true });
}

export async function deleteStore(plugin: string, profile: string): Promise<void> {
  const dir = await storeDir(plugin, profile);
  assertTestWritable(dir, 'plugin store');
  await rm(dir, { recursive: true, force: true });
}
