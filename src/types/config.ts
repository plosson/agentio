export interface Config {
  profiles: {
    gmail?: string[];
    gchat?: string[];
    jira?: string[];
    slack?: string[];
    telegram?: string[];
    discourse?: string[];
    sql?: string[];
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
    slack?: string;
    telegram?: string;
    discourse?: string;
    sql?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira' | 'slack' | 'telegram' | 'discourse' | 'sql';
