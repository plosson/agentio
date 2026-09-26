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
  canManageProfiles?: boolean; // may add, replace, rename and delete profiles from an agent machine
  canAddProfiles?: boolean;    // v2.4.0 spelling of the same right, read as a fallback in view()
  createdAt: string;       // ISO
  lastUsedAt?: string;     // ISO
}

export interface Config {
  /**
   * Profile entries are keyed by the validated plugin id. Keep this open: a
   * vault may outlive the binary that wrote it, or be shared with a build that
   * has a different plugin catalog.
   */
  profiles: Record<string, ProfileValue[] | undefined>;
  apiKeys?: ApiKey[];
}

/** Built-in profile service ids, useful only where compile-time narrowing helps. */
export type BuiltInServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'gsheets' | 'gslides' | 'gscript' | 'github' | 'jira' | 'confluence' | 'slack' | 'discourse' | 'dropbox' | 'sql' | 'revolut' | 'falco';

/**
 * A plugin id after registry validation. External plugin ids make the service
 * namespace open at runtime, so persistence and protocol code must not use a
 * closed union here.
 */
export type ServiceName = string;

export const ALL_SERVICES: readonly BuiltInServiceName[] = [
  'gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'gslides', 'gscript',
  'github', 'jira', 'confluence', 'slack', 'discourse', 'dropbox', 'sql', 'revolut', 'falco',
];
