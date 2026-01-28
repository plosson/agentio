export interface GatewayApiConfig {
  port?: number;
  host?: string;
  secret?: string;
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
  name?: string;           // Gateway identity name
  secret?: string;         // Shared secret for API auth and teleport
  api?: GatewayApiConfig;
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
