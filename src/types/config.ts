export interface DaemonServerConfig {
  // Server binding for the local daemon HTTP API
  port?: number;          // Port to bind (default: 7890)
  host?: string;          // Host to bind (default: 0.0.0.0)
}

export interface DaemonConfig {
  apiKey?: string;                 // API key for authentication
  server?: DaemonServerConfig;     // Server binding settings
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
    dropbox?: ProfileValue[];
    sql?: ProfileValue[];
    revolut?: ProfileValue[];
  };
  env?: Record<string, string>;
  daemon?: DaemonConfig;
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'gsheets' | 'gslides' | 'gscript' | 'github' | 'jira' | 'confluence' | 'slack' | 'telegram' | 'discourse' | 'dropbox' | 'sql' | 'revolut';

export const ALL_SERVICES: readonly ServiceName[] = [
  'gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'gslides', 'gscript',
  'github', 'jira', 'confluence', 'slack', 'telegram', 'discourse', 'dropbox', 'sql', 'revolut',
];
