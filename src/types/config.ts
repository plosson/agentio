export interface GatewayServerConfig {
  // Server binding (for the local daemon's scheduler API)
  port?: number;          // Port to bind (default: 7890)
  host?: string;          // Host to bind (default: 0.0.0.0 for server)
}

export interface BaseDaemonConfig {
  apiKey?: string;         // API key for authentication
  server?: GatewayServerConfig;  // Server binding settings (for running daemon)
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
    sql?: ProfileValue[];
  };
  env?: Record<string, string>;
  daemon?: DaemonConfig;
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'gsheets' | 'gslides' | 'gscript' | 'github' | 'jira' | 'confluence' | 'slack' | 'telegram' | 'discourse' | 'sql';

export const ALL_SERVICES: readonly ServiceName[] = [
  'gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'gslides', 'gscript',
  'github', 'jira', 'confluence', 'slack', 'telegram', 'discourse', 'sql',
];
