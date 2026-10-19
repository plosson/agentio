import { Database } from 'bun:sqlite';
import { existsSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { assertTestWritable, readPointer } from '../vault/pointer';
import { CliError } from '../utils/errors';
import { normalizeEvent, type UsageInput } from './event';

/**
 * Credential uses, one row each, in `usage.db` next to the vault. Not in the
 * vault: it is written on every command, and holds no secret (no arguments,
 * no credentials). Recording is best effort: a store that cannot be opened or
 * written loses the event, never the command.
 */

export const RETENTION_DAYS = 90;
export const DAY_MS = 86_400_000;
const BUSY_TIMEOUT_MS = 200;
const CORRUPT_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);

export const USAGE_GROUPS = ['machine', 'key', 'service', 'profile', 'command', 'day'] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface UsageRow {
  group: string;
  count: number;
  failures: number;
  lastSeen: number;
}

/** Uses of one service on one UTC day, for the admin page's chart. */
export interface DailyServiceRow {
  day: string;
  service: string;
  count: number;
}

/** A machine's row, with the key it used, so the admin page can link to it. */
export interface MachineRow extends UsageRow {
  host: string;
  keyId: string;
  keyName: string;
}

/** The SQL each grouping selects; only these fixed strings ever reach a query. */
const GROUP_SQL: Record<UsageGroup, string> = {
  machine: "host || ' · ' || key_name",
  key: 'key_name',
  service: 'service',
  profile: "service || '/' || profile",
  command: 'command',
  day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')",
};

let db: Database | null = null;
let dbPath: string | null = null;
let warned = false;

export async function usageDbPath(): Promise<string | null> {
  const vault = await readPointer();
  return vault ? join(dirname(vault), 'usage.db') : null;
}

function init(path: string): Database {
  // SQLite gives its WAL files the database file's mode, so creating it 0600 covers them too.
  if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
  const d = new Database(path, { create: true });
  try {
    d.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    d.exec('PRAGMA journal_mode = WAL');
    // Safe in WAL mode, and spares an fsync per recorded credential request.
    d.exec('PRAGMA synchronous = NORMAL');
    d.exec(`CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL, service TEXT NOT NULL, profile TEXT NOT NULL, command TEXT NOT NULL,
      host TEXT NOT NULL, key_id TEXT NOT NULL, key_name TEXT NOT NULL, outcome TEXT NOT NULL,
      refreshed INTEGER, version TEXT NOT NULL)`);
    d.exec('CREATE INDEX IF NOT EXISTS events_ts ON events (ts)');
    d.exec('CREATE INDEX IF NOT EXISTS events_key ON events (key_id)');
    d.exec('CREATE INDEX IF NOT EXISTS events_profile ON events (service, profile)');
    d.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    return d;
  } catch (err) {
    d.close();
    throw err;
  }
}

/** The open store for `path`; a file SQLite cannot read is set aside and replaced. */
function open(path: string): Database {
  if (db && dbPath === path) return db;
  closeUsageStore();
  assertTestWritable(path, 'usage store');
  try {
    db = init(path);
  } catch (err) {
    if (!CORRUPT_CODES.has((err as { code?: string }).code ?? '')) throw err;
    renameSync(path, `${path}.corrupt-${Date.now()}`);
    db = init(path);
  }
  dbPath = path;
  return db;
}

export function closeUsageStore(): void {
  db?.close();
  db = null;
  dbPath = null;
}

/** Old rows go at most once a day, on a write: no job to schedule. */
function prune(d: Database, now: number): void {
  const last = d.query<{ value: number }, []>("SELECT value FROM meta WHERE name = 'pruned'").get()?.value ?? 0;
  if (now - last < DAY_MS) return;
  d.query('DELETE FROM events WHERE ts < ?').run(now - RETENTION_DAYS * DAY_MS);
  d.query("INSERT INTO meta (name, value) VALUES ('pruned', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(now);
}

/** With AGENTIO_DEBUG set, say once per process why an event was lost. */
export function warnOnce(err: unknown): void {
  if (warned || !process.env.AGENTIO_DEBUG) return;
  warned = true;
  console.error(`agentio: usage not recorded: ${err instanceof Error ? err.message : String(err)}`);
}

/** Record one credential use. Never throws. */
export async function recordUsage(input: UsageInput): Promise<void> {
  try {
    const path = await usageDbPath();
    if (!path) return;
    const d = open(path);
    const e = normalizeEvent(input);
    d.query(`INSERT INTO events (ts, service, profile, command, host, key_id, key_name, outcome, refreshed, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.ts, e.service, e.profile, e.command, e.host, e.keyId, e.keyName, e.outcome,
        e.refreshed === null ? null : e.refreshed ? 1 : 0, e.version);
    prune(d, e.ts);
  } catch (err) {
    warnOnce(err);
  }
}

/** Rows of `sql` (one `?`: the window's start) over the last `since` ms; none, and no file, while no store exists. */
async function inWindow<T>(sql: string, since: number, now: number): Promise<T[]> {
  const path = await usageDbPath();
  if (!path || !existsSync(path)) return [];
  return open(path).query(sql).all(now - since) as T[];
}

const COUNTS = "COUNT(*) AS count, SUM(outcome <> 'ok') AS failures, MAX(ts) AS lastSeen";

/** Counts per group over the last `since` ms, most used first (by day: oldest first). */
export async function queryUsage({ by, since, now = Date.now() }: { by: UsageGroup; since: number; now?: number }): Promise<UsageRow[]> {
  if (!Object.hasOwn(GROUP_SQL, by)) {
    throw new CliError('INVALID_PARAMS', `Unknown grouping: ${String(by)}`, `Use one of: ${USAGE_GROUPS.join(', ')}`);
  }
  const order = by === 'day' ? '1 ASC' : 'count DESC, 1 ASC';
  return inWindow(`SELECT ${GROUP_SQL[by]} AS "group", ${COUNTS} FROM events WHERE ts >= ? GROUP BY 1 ORDER BY ${order}`, since, now);
}

/** Uses per UTC day and service over the last `since` ms, oldest day first. */
export function queryDailyByService({ since, now = Date.now() }: { since: number; now?: number }): Promise<DailyServiceRow[]> {
  return inWindow(`SELECT ${GROUP_SQL.day} AS day, service, COUNT(*) AS count
    FROM events WHERE ts >= ? GROUP BY 1, 2 ORDER BY 1 ASC, 3 DESC, 2 ASC`, since, now);
}

/** Counts per machine and key over the last `since` ms, most used first. Two keys with one name stay apart. */
export function queryMachines({ since, now = Date.now() }: { since: number; now?: number }): Promise<MachineRow[]> {
  return inWindow(`SELECT ${GROUP_SQL.machine} AS "group", host, key_id AS keyId, key_name AS keyName, ${COUNTS}
    FROM events WHERE ts >= ? GROUP BY host, key_id, key_name ORDER BY count DESC, 1 ASC, keyId ASC`, since, now);
}
