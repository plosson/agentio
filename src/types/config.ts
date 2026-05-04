import type { ServerConfig } from './server';

export interface GatewayServerConfig {
  // Server binding (for running a gateway daemon)
  port?: number;          // Port to bind (default: 7890)
  host?: string;          // Host to bind (default: 0.0.0.0 for server)
}

export interface GatewayWebhookConfig {
  url?: string;
  secret?: string;
  debounceMs?: number;
}

export interface GatewayMediaConfig {
  download?: boolean;
  maxSizeMb?: number;
}

export interface GatewayRetentionConfig {
  doneMessagesDays?: number;
  sentMessagesDays?: number;
}

export interface BaseDaemonConfig {
  name?: string;           // Gateway identity name (for local server identification)
  apiUrl?: string;         // Gateway URL (e.g., "https://gateway.example.com:7890")
  apiKey?: string;         // API key for authentication
  server?: GatewayServerConfig;  // Server binding settings (for running daemon)
  webhook?: GatewayWebhookConfig;
  media?: GatewayMediaConfig;
  retention?: GatewayRetentionConfig;
}

/** @deprecated use DaemonConfig */
export type GatewayConfig = BaseDaemonConfig;

export interface WatchedFolder {
  path: string;      // absolute path
  host?: string;     // optional hostname pin; skip if current host mismatches
  addedAt: number;   // unix ms
}

export interface SchedulerConfig {
  watchedFolders: WatchedFolder[];
  tickIntervalSec?: number;  // default 60
}

export interface DaemonConfig extends BaseDaemonConfig {
  scheduler?: SchedulerConfig;
}

export interface ProfileEntry {
  name: string;
  readOnly?: boolean;
}

// Helper type for backward compatibility during migration
export type ProfileValue = string | ProfileEntry;

/**
 * Record of a successfully teleported siteio app. Persisted so that
 * `agentio mcp teleport --sync` (and other name-optional variants) can
 * default to the most recently deployed app instead of forcing the
 * user to re-type the name every time.
 */
export interface TeleportAppRecord {
  name: string;
  url?: string;
  /** Unix epoch milliseconds of the last successful deploy or sync. */
  deployedAt: number;
}

export interface TeleportConfig {
  lastApp?: TeleportAppRecord;
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
    github?: ProfileValue[];
    jira?: ProfileValue[];
    confluence?: ProfileValue[];
    slack?: ProfileValue[];
    telegram?: ProfileValue[];
    whatsapp?: ProfileValue[];
    discourse?: ProfileValue[];
    sql?: ProfileValue[];
  };
  env?: Record<string, string>;
  daemon?: DaemonConfig;
  gateway?: GatewayConfig;  // legacy; read-only, migrated to daemon on load
  server?: ServerConfig;
  teleport?: TeleportConfig;
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'gsheets' | 'gslides' | 'github' | 'jira' | 'confluence' | 'slack' | 'telegram' | 'whatsapp' | 'discourse' | 'sql';

export const ALL_SERVICES: readonly ServiceName[] = [
  'gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'gslides',
  'github', 'jira', 'confluence', 'slack', 'telegram', 'whatsapp', 'discourse', 'sql',
];
