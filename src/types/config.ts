export interface Config {
  profiles: {
    gmail?: string[];
    gchat?: string[];
    github?: string[];
    jira?: string[];
    slack?: string[];
    telegram?: string[];
    discourse?: string[];
    sql?: string[];
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    github?: string;
    jira?: string;
    slack?: string;
    telegram?: string;
    discourse?: string;
    sql?: string;
  };
  env?: Record<string, string>;
}

export type ServiceName = 'gmail' | 'gchat' | 'github' | 'jira' | 'slack' | 'telegram' | 'discourse' | 'sql';
