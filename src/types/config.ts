export interface ProfileEntry {
  name: string;
  readOnly?: boolean;
}

// Helper type for backward compatibility during migration
export type ProfileValue = string | ProfileEntry;

/** `*` or `service/name` pairs. */
export type ApiKeyScope = '*' | string[];

/** A remote agent's key. The secret is never stored, only its SHA-256. */
export interface ApiKey {
  id: string;              // short id embedded in the token
  name: string;
  secretHash: string;      // sha256 hex of the 32-byte secret
  hint?: string;           // last characters of the secret, to tell tokens apart
  allowedProfiles: ApiKeyScope;
  readOnly: boolean;       // forces read-only on every profile the key can see
  createdAt: string;       // ISO
  lastUsedAt?: string;     // ISO
}

export interface Config {
  profiles: {
    gdocs?: ProfileValue[];
    gdrive?: ProfileValue[];
    gmail?: ProfileValue[];
    gcal?: ProfileValue[];
    gtasks?: ProfileValue[];
    gchat?: ProfileValue[];
    gsheets?: ProfileValue[];
    gslides?: ProfileValue[];
    gscript?: ProfileValue[];
    github?: ProfileValue[];
    jira?: ProfileValue[];
    confluence?: ProfileValue[];
    slack?: ProfileValue[];
    telegram?: ProfileValue[];
    discourse?: ProfileValue[];
    dropbox?: ProfileValue[];
    sql?: ProfileValue[];
    revolut?: ProfileValue[];
  };
  apiKeys?: ApiKey[];
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'gsheets' | 'gslides' | 'gscript' | 'github' | 'jira' | 'confluence' | 'slack' | 'telegram' | 'discourse' | 'dropbox' | 'sql' | 'revolut';

export const ALL_SERVICES: readonly ServiceName[] = [
  'gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'gslides', 'gscript',
  'github', 'jira', 'confluence', 'slack', 'telegram', 'discourse', 'dropbox', 'sql', 'revolut',
];
