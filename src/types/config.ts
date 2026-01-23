export interface Config {
  profiles: {
    gdocs?: string[];
    gdrive?: string[];
    gmail?: string[];
    gchat?: string[];
    github?: string[];
    jira?: string[];
    slack?: string[];
    telegram?: string[];
    discourse?: string[];
    sql?: string[];
  };
  env?: Record<string, string>;
}

export type ServiceName = 'gdocs' | 'gdrive' | 'gmail' | 'gchat' | 'github' | 'jira' | 'slack' | 'telegram' | 'discourse' | 'sql';
