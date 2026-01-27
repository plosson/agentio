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

export interface Config {
  profiles: {
    gdocs?: string[];
    gdrive?: string[];
    gmail?: string[];
    gcal?: string[];
    gtasks?: string[];
    gchat?: string[];
    github?: string[];
    jira?: string[];
    slack?: string[];
    telegram?: string[];
    whatsapp?: string[];
    discourse?: string[];
    sql?: string[];
  };
  env?: Record<string, string>;
  gateway?: GatewayConfig;
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gcal' | 'gtasks' | 'gchat' | 'github' | 'jira' | 'slack' | 'telegram' | 'whatsapp' | 'discourse' | 'sql';
