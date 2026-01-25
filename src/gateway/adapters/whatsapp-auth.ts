/**
 * SQLite-based auth state store for Baileys
 * Implements the AuthenticationState interface required by Baileys
 */
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { proto } from '@whiskeysockets/baileys';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { getDatabase } from '../store';

interface AuthCredsRow {
  profile: string;
  data: string;
  updated_at: number;
}

interface AuthKeyRow {
  profile: string;
  type: string;
  key_id: string;
  data: string;
}

/**
 * Create a SQLite-based auth state for Baileys
 */
export async function useSQLiteAuthState(profile: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}> {
  const db = getDatabase();

  // Load or initialize credentials
  const loadCreds = (): AuthenticationCreds => {
    const row = db.query<AuthCredsRow, [string]>(
      'SELECT data FROM whatsapp_auth_creds WHERE profile = ?'
    ).get(profile);

    if (row) {
      return JSON.parse(row.data, BufferJSON.reviver);
    }

    // Initialize new credentials
    return initAuthCreds();
  };

  // Save credentials
  const saveCreds = async (): Promise<void> => {
    const data = JSON.stringify(creds, BufferJSON.replacer);
    db.run(
      `INSERT OR REPLACE INTO whatsapp_auth_creds (profile, data, updated_at)
       VALUES (?, ?, ?)`,
      [profile, data, Date.now()]
    );
  };

  // Clear all auth state for this profile
  const clearState = async (): Promise<void> => {
    db.run('DELETE FROM whatsapp_auth_creds WHERE profile = ?', [profile]);
    db.run('DELETE FROM whatsapp_auth_keys WHERE profile = ?', [profile]);
  };

  // Read keys from database
  const readData = <T>(type: string, ids: string[]): { [id: string]: T } => {
    const result: { [id: string]: T } = {};

    if (ids.length === 0) return result;

    // Build query with placeholders
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.query<AuthKeyRow, string[]>(
      `SELECT key_id, data FROM whatsapp_auth_keys
       WHERE profile = ? AND type = ? AND key_id IN (${placeholders})`
    ).all(profile, type, ...ids);

    for (const row of rows) {
      try {
        result[row.key_id] = JSON.parse(row.data, BufferJSON.reviver);
      } catch {
        // Skip invalid data
      }
    }

    return result;
  };

  // Write keys to database
  const writeData = <T>(type: string, data: { [id: string]: T }): void => {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO whatsapp_auth_keys (profile, type, key_id, data)
       VALUES (?, ?, ?, ?)`
    );

    for (const [id, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        stmt.run(profile, type, id, JSON.stringify(value, BufferJSON.replacer));
      }
    }
  };

  // Delete keys from database
  const removeData = (type: string, ids: string[]): void => {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(', ');
    db.run(
      `DELETE FROM whatsapp_auth_keys
       WHERE profile = ? AND type = ? AND key_id IN (${placeholders})`,
      [profile, type, ...ids]
    );
  };

  const creds = loadCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): { [id: string]: SignalDataTypeMap[T] } => {
        return readData<SignalDataTypeMap[T]>(type, ids);
      },
      set: (data: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }): void => {
        for (const [type, typeData] of Object.entries(data)) {
          if (!typeData) continue;

          const toWrite: { [id: string]: unknown } = {};
          const toDelete: string[] = [];

          for (const [id, value] of Object.entries(typeData)) {
            if (value === null || value === undefined) {
              toDelete.push(id);
            } else {
              toWrite[id] = value;
            }
          }

          if (Object.keys(toWrite).length > 0) {
            writeData(type, toWrite);
          }
          if (toDelete.length > 0) {
            removeData(type, toDelete);
          }
        }
      },
    },
  };

  return {
    state,
    saveCreds,
    clearState,
  };
}

/**
 * Check if a profile has existing auth state
 */
export function hasAuthState(profile: string): boolean {
  const db = getDatabase();
  const row = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM whatsapp_auth_creds WHERE profile = ?'
  ).get(profile);
  return (row?.count ?? 0) > 0;
}

/**
 * Delete auth state for a profile
 */
export function deleteAuthState(profile: string): void {
  const db = getDatabase();
  db.run('DELETE FROM whatsapp_auth_creds WHERE profile = ?', [profile]);
  db.run('DELETE FROM whatsapp_auth_keys WHERE profile = ?', [profile]);
}
