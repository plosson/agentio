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

export interface GatewayConfig {
  name?: string;           // Gateway identity name (for local server identification)
  apiUrl?: string;         // Gateway URL (e.g., "https://gateway.example.com:7890")
  apiKey?: string;         // API key for authentication
  server?: GatewayServerConfig;  // Server binding settings (for running daemon)
  webhook?: GatewayWebhookConfig;
  media?: GatewayMediaConfig;
  retention?: GatewayRetentionConfig;
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
    github?: ProfileValue[];
    jira?: ProfileValue[];
    slack?: ProfileValue[];
    telegram?: ProfileValue[];
    whatsapp?: ProfileValue[];
    discourse?: ProfileValue[];
    sql?: ProfileValue[];
  };
  env?: Record<string, string>;
  gateway?: GatewayConfig;
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'gsheets' | 'github' | 'jira' | 'slack' | 'telegram' | 'whatsapp' | 'discourse' | 'sql';
