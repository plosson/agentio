# WhatsApp Auth State Store Implementation Plan

## Overview

Implement a SQLite-based auth state store for Baileys (WhatsApp library) that integrates with the gateway's existing `gateway.db` database. This replaces Baileys' default file-based `useMultiFileAuthState` with a database-backed solution.

## Why SQLite?

1. **Portability** - Single `gateway.db` file can be backed up or moved between servers
2. **Atomicity** - SQLite transactions prevent partial writes during key updates
3. **Multi-profile** - All WhatsApp profiles stored in one place
4. **Consistency** - Matches gateway's inbox/outbox storage pattern
5. **No hardware binding** - WhatsApp device identity is purely cryptographic, not tied to machine

## Baileys Auth State Structure

Baileys requires an `AuthenticationState` object with two parts:

```typescript
interface AuthenticationState {
  creds: AuthenticationCreds;  // Identity, account info (relatively static)
  keys: SignalKeyStore;        // Signal protocol keys (updated frequently)
}
```

### Credentials (`creds`)

Stored in `creds.json` by default. Contains:
- `signedIdentityKey` - Device identity key pair
- `signedPreKey` - Signed pre-key for Signal protocol
- `registrationId` - Device registration ID
- `noiseKey` - Noise protocol key pair
- `me` - Account info (phone number, name)
- `account` - Signed device identity from WhatsApp
- `firstUnuploadedPreKeyId`, `nextPreKeyId` - Pre-key management
- And other session metadata

### Keys (`keys`)

Stored as individual files (`{type}-{id}.json`). Key types:
- `pre-key` - One-time pre-keys (KeyPair)
- `session` - Signal sessions with contacts (Uint8Array)
- `sender-key` - Group sender keys (Uint8Array)
- `sender-key-memory` - Sender key cache (boolean map)
- `app-state-sync-key` - App state sync keys (protobuf)
- `app-state-sync-version` - Sync version state
- `lid-mapping` - Linked ID mappings (string)
- `device-list` - Device arrays per contact

## Database Schema

Add to `gateway.db`:

```sql
-- WhatsApp credentials (one row per profile)
CREATE TABLE whatsapp_creds (
  profile TEXT PRIMARY KEY,
  data TEXT NOT NULL,           -- JSON-serialized AuthenticationCreds
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- WhatsApp Signal keys (many rows per profile)
CREATE TABLE whatsapp_keys (
  profile TEXT NOT NULL,
  type TEXT NOT NULL,           -- pre-key, session, sender-key, etc.
  key_id TEXT NOT NULL,         -- key identifier
  data TEXT NOT NULL,           -- JSON-serialized key data
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile, type, key_id)
);

CREATE INDEX idx_whatsapp_keys_profile ON whatsapp_keys(profile);
```

## Implementation

### File: `src/gateway/whatsapp-auth-store.ts`

```typescript
import { Database } from 'bun:sqlite';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
} from '@whiskeysockets/baileys';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

export interface WhatsAppAuthStore {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  deleteCreds: () => Promise<void>;
}

export async function useGatewayAuthState(
  db: Database,
  profile: string
): Promise<WhatsAppAuthStore> {

  // --- Credentials ---

  const loadCreds = (): AuthenticationCreds => {
    const row = db.query(
      'SELECT data FROM whatsapp_creds WHERE profile = ?'
    ).get(profile) as { data: string } | null;

    if (row) {
      return JSON.parse(row.data, BufferJSON.reviver);
    }
    return initAuthCreds();
  };

  const saveCreds = async (): Promise<void> => {
    const now = Date.now();
    const data = JSON.stringify(creds, BufferJSON.replacer);

    db.run(`
      INSERT INTO whatsapp_creds (profile, data, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile) DO UPDATE SET data = ?, updated_at = ?
    `, [profile, data, now, now, data, now]);
  };

  const deleteCreds = async (): Promise<void> => {
    db.run('DELETE FROM whatsapp_creds WHERE profile = ?', [profile]);
    db.run('DELETE FROM whatsapp_keys WHERE profile = ?', [profile]);
  };

  // --- Keys ---

  const getKeys = async <T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[]
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
    const result: { [id: string]: SignalDataTypeMap[T] } = {};

    if (ids.length === 0) return result;

    const placeholders = ids.map(() => '?').join(',');
    const rows = db.query(`
      SELECT key_id, data FROM whatsapp_keys
      WHERE profile = ? AND type = ? AND key_id IN (${placeholders})
    `).all(profile, type, ...ids) as Array<{ key_id: string; data: string }>;

    for (const row of rows) {
      let value = JSON.parse(row.data, BufferJSON.reviver);

      // Reconstruct protobuf for app-state-sync-key
      if (type === 'app-state-sync-key' && value) {
        value = proto.Message.AppStateSyncKeyData.fromObject(value);
      }

      result[row.key_id] = value;
    }

    return result;
  };

  const setKeys = async (data: SignalDataSet): Promise<void> => {
    const now = Date.now();

    db.transaction(() => {
      for (const type in data) {
        const entries = data[type as keyof SignalDataSet];
        for (const id in entries) {
          const value = entries[id];

          if (value) {
            const serialized = JSON.stringify(value, BufferJSON.replacer);
            db.run(`
              INSERT INTO whatsapp_keys (profile, type, key_id, data, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(profile, type, key_id) DO UPDATE SET data = ?, updated_at = ?
            `, [profile, type, id, serialized, now, serialized, now]);
          } else {
            // null value = delete
            db.run(
              'DELETE FROM whatsapp_keys WHERE profile = ? AND type = ? AND key_id = ?',
              [profile, type, id]
            );
          }
        }
      }
    })();
  };

  // --- Initialize ---

  const creds = loadCreds();

  return {
    state: {
      creds,
      keys: {
        get: getKeys,
        set: setKeys,
      },
    },
    saveCreds,
    deleteCreds,
  };
}
```

### Usage in WhatsApp Adapter

```typescript
// src/gateway/adapters/whatsapp.ts

import { makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import { useGatewayAuthState } from '../whatsapp-auth-store';

async function connect(db: Database, profile: string) {
  const { state, saveCreds } = await useGatewayAuthState(db, profile);

  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    // ... other options
  });

  // Critical: save credentials on every update
  socket.ev.on('creds.update', saveCreds);

  return socket;
}
```

## Migration

Add schema migration to gateway store initialization:

```typescript
// src/gateway/store.ts

function initSchema(db: Database) {
  // Existing inbox/outbox tables...

  // WhatsApp auth tables
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_creds (
      profile TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_keys (
      profile TEXT NOT NULL,
      type TEXT NOT NULL,
      key_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile, type, key_id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_keys_profile
    ON whatsapp_keys(profile)
  `);
}
```

## Implementation Checklist

- [ ] Add `@whiskeysockets/baileys` dependency to package.json
- [ ] Create `src/gateway/whatsapp-auth-store.ts` with `useGatewayAuthState()`
- [ ] Add WhatsApp tables to gateway store schema initialization
- [ ] Create `src/gateway/adapters/whatsapp.ts` using the auth store
- [ ] Add profile management for WhatsApp (QR code pairing flow)
- [ ] Test: Create profile, pair device, restart gateway, verify session persists
- [ ] Test: Migrate gateway.db to another machine, verify WhatsApp still authenticated

## Edge Cases

1. **Concurrent key updates** - SQLite handles this; transactions ensure atomicity
2. **Corrupt session** - If Baileys throws auth errors, offer `profile remove` to wipe and re-pair
3. **Large key counts** - Index on profile ensures fast lookups; consider periodic cleanup of old sender-keys
4. **Binary data** - BufferJSON handles Uint8Array serialization to base64

## Future Considerations

1. **Key rotation cleanup** - Old pre-keys could be pruned after confirmed upload
2. **Export/import** - Allow exporting auth state for backup (encrypted)
3. **Multiple devices** - WhatsApp limits linked devices; handle gracefully
